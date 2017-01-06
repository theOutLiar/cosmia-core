'use strict';

import fs from 'fs';
import path from 'path';
import mkdirp from 'mkdirp'; //like `mkdir -p`

import keys from 'lodash.keys';

import recursiveReaddir from 'recursive-readdir';
import handlebars from 'handlebars';

import htmlparser, {
    DomUtils
}
from 'htmlparser2';

import chalk from 'chalk';

const EXTENSION_HBS = '.hbs';
const EXTENSION_JSON = '.json';
const EXTENSION_JS = '.js';
const EXTENSION_MD = '.md';

const COSMIA_PARTIAL_PATH = 'views/partials';
const COSMIA_DATA_PATH = 'views/data';
const COSMIA_LAYOUT_PATH = 'views/layouts';
const COSMIA_HELPERS_PATH = 'views/helpers';
const COSMIA_PAGES_PATH = 'views/pages';
const COSMIA_COLLECTIONS_PATH = 'views/collections';

const COSMIA_SCRIPT = 'cosmia-script';
const COSMIA_DATA = 'cosmia-data';
const COSMIA_TEMPLATE_DATA = 'cosmia-template-data';
const COSMIA_COLLECTION_DATA = 'cosmia-collection-data';
const COSMIA_COLLECTION_PREFIX = 'cosmia-collection-';

const PACKAGE_NAME = chalk.blue('cosmia-core');

const ERROR_MESSAGE_COSMIA_CUSTOM_CHILD = 'cosmia custom elements may only have a single text child.';
const ERORR_MESSAGE_COSMIA_CUSTOM_ELEMENT = 'Only one of a given type of cosmia custom element is allowed per page.';

var siteData = {};
var handlebarsLayouts = {};
var pageData = {};
var collectionData = {};

var partialsDir = '';
var dataDir = '';
var layoutsDir = '';
var helpersDir = '';
var pagesDir = '';
var collectionsDir = '';
var srcDir = '';

//Used to pull an element with a cosmia-* attribute from the .hbs file
function _extractCustomPageElement(page, attribute, process) {
    //parse the html and dig out the relevant data element by custom attribute
    var dom = new htmlparser.parseDOM(page.content);

    //find an element with the specified `attribute`
    var dataElements = DomUtils.find((e) =>
        (e.attribs !== undefined && e.attribs[attribute] !== undefined),
        dom, true);

    if (dataElements.length > 1) {
        throw ERORR_MESSAGE_COSMIA_CUSTOM_ELEMENT;
    }

    if (dataElements.length) {
        var element = dataElements[0];

        if (element.children.length > 1) {
            throw ERROR_MESSAGE_COSMIA_CUSTOM_CHILD;
        }

        if (element.children.length) {
            try {
                page[attribute] = process(element);
            } catch (err) {
                throw page.path + '\n' + err;
            }
        }

        //this doesn't seem like the fastest approach, but the DomUtils removeElement call
        //doesn't appear to work correctly/how i'd expect it to, and is not documented,
        //so falling back to a string operation
        page.content = DomUtils.getOuterHTML(dom).replace(DomUtils.getOuterHTML(element), '');
    }
    return page;
}

function _registerDataFile(name, content, dirName) {
    var splitPath = name.replace(dataDir + '/', '').split('/');
    var treeNode = siteData;
    var objectName = '';
    var dataObject = JSON.parse(content);
    while (splitPath.length) {
        objectName = splitPath.shift();
        treeNode[objectName] = splitPath.length ? Object.assign({}, treeNode[objectName]) : dataObject;
        treeNode = treeNode[objectName];
    }
}

function _registerPartialFile(name, content, dirName) {
    handlebars.registerPartial(path.basename(name), content);
}

function _registerLayoutFile(name, content, dirName) {
    var layout = {
        content: content,
        path: name
    };
    layout = _extractCustomPageElement(layout, COSMIA_TEMPLATE_DATA, (e) => JSON.parse(DomUtils.getInnerHTML(e)));
    layout.compile = handlebars.compile(layout.content);
    handlebarsLayouts[path.basename(name)] = layout;
}

function _registerHelperFile(name, content, dirName) {
    handlebars.registerHelper(require(path.resolve(name)));
}

function _processPage(name, content, dirName) {
    var page = {
        path: name,
        content: content
    };
    page = _extractCustomPageElement(page, COSMIA_DATA, (e) => JSON.parse(DomUtils.getInnerHTML(e)));
    page = _extractCustomPageElement(page, COSMIA_SCRIPT, (e) => DomUtils.getOuterHTML(e));
    var keyName = path.join('.', name.replace(dirName, ''));
    pageData[keyName] = page;
}

//read all the files of a given type in a directory and execute a process on their content
//the processor takes the form function (name, content, dirName, key){ ... }
function _processDirectory(dirName, extension, processor, key) {
    return new Promise((resolve, reject) => {
        recursiveReaddir(dirName, (err, files) => {
            if (err) {
                reject(err);
                return;
            }
            files.forEach((filename) => {
                if (path.extname(filename) === extension) {

                    var nameWithoutExtension = path.resolve(path.dirname(filename), path.basename(filename, extension));
                    var fileContent = fs.readFileSync(path.resolve(dirName, filename), 'utf8');

                    new Promise((resolve, reject) => {
                        try {
                            processor(nameWithoutExtension, fileContent, dirName, key);
                        } catch (err) {
                            reject(err);
                            return;
                        }
                    }).catch((err) => {
                        reject(err);
                    });
                }
            });
            return resolve();
        });
    }).catch((err) => {
        console.error(err);
    });
}

//handle collection content
function _processCollectionFile(name, content, dirName, key) {
    var data = collectionData[key];
    name = name.replace(dirName, '');
    name = (data['single-path'] ? data['single-path'] : data['index-path']) + name;
    var page = {
        path: name,
        content: content
    };

    var keyName = path.join('.', name);
    for (var field of keys(data['content-fields'])) {
        page = _extractCustomPageElement(page, `${COSMIA_COLLECTION_PREFIX}${field}`, (e) => DomUtils.getInnerHTML(e));
        page = _extractCustomPageElement(page, COSMIA_COLLECTION_DATA, (e) => JSON.parse(DomUtils.getInnerHTML(e)));
    }

    page[COSMIA_DATA] = Object.assign({}, page[`${COSMIA_COLLECTION_PREFIX}${field}`], page[COSMIA_COLLECTION_DATA]);
    page[COSMIA_DATA]['layout'] = collectionData[key]['single-layout'];
    pageData[keyName] = page;
    collectionData[key]['page'] = page;
    console.log('processed collection file...');
}

//handle collection meta data
function _processCollectionData(name, content, dirName) {
    console.log('processing collection data..');
    var collection = JSON.parse(content);
    var keyName = path.join('.', name.replace(dirName, ''));
    collectionData[keyName] = collection;
    var collectionSourceDir = path.resolve(srcDir, collectionData[keyName]['source']);
    _processDirectory(collectionSourceDir, EXTENSION_MD, _processCollectionFile, keyName)
        .catch((err) => {
            console.log('err');
        });
}

function _registerAppComponents() {
    //register assemble's handlebars helpers
    handlebars.registerHelper(require('handlebars-helpers')());

    //register custom layouts, partials, data, and helpers
    return Promise.all(
        _processDirectory(partialsDir, EXTENSION_HBS, _registerPartialFile),
        _processDirectory(dataDir, EXTENSION_JSON, _registerDataFile),
        _processDirectory(layoutsDir, EXTENSION_HBS, _registerLayoutFile),
        _processDirectory(helpersDir, EXTENSION_JS, _registerHelperFile)
    ).then(() => {
        console.log(`${PACKAGE_NAME}: Components registered`);
    }).catch((err) => {
        console.error(err);
    });
}

function _compilePage(page, customData = {}, silent = false) {
    console.log('compile page');
    //TODO: make sure cosmia custom elements are set in a single pass.
    //as it stands, we'll need two new lines for each additional custom
    //element, but it could be reduced to one new line
    var pageContext = Object.assign({}, siteData, page['cosmia-data'], customData);
    pageContext['cosmia-script'] = page['cosmia-script'];
    pageContext['cosmia-data'] = page['cosmia-data'];

    var canonicalPath = path.join('/', page.path.replace(pagesDir, '') + '.html');

    //ideally, everything should be an index.html file in the end
    //if it's not, we'll leave the full path in the canonical url
    if (/^index.html$/.test(path.basename(canonicalPath))) {
        canonicalPath = canonicalPath.replace(path.basename(canonicalPath), '');
    }

    pageContext['page-path'] = canonicalPath;

    var pageLayoutName = (pageContext.layout ? pageContext.layout : 'default');
    var compiledPage = handlebars.compile(page.content);
    var pageBody = compiledPage(pageContext);

    if (handlebarsLayouts[pageLayoutName] === undefined && !silent) {
        console.warn(chalk.yellow(`${PACKAGE_NAME}: WARNING: Layout ${pageLayoutName} not found. Using default instead.`));
        pageLayoutName = 'default';
    }

    var layoutName = pageLayoutName;
    var templateData = null;
    pageContext['cosmia-template-data'] = {};
    //Iterate up the layout tree.
    //Child layouts override parent layout data
    do {
        templateData = handlebarsLayouts[layoutName]['cosmia-template-data'];
        pageContext['cosmia-template-data'] = Object.assign({}, (templateData ? templateData : {}), pageContext['cosmia-template-data']);
        layoutName = templateData && templateData.parent ? templateData.parent : false;
    } while (layoutName);

    templateData = pageContext['cosmia-template-data'];

    layoutName = pageLayoutName;

    do {
        pageBody = (handlebarsLayouts[layoutName]).compile(Object.assign({}, {
            body: pageBody
        }, pageContext));
        templateData = handlebarsLayouts[layoutName]['cosmia-template-data'];
        layoutName = templateData && templateData.parent ? templateData.parent : false;
    } while (layoutName);

    return pageBody;
}

function _compilePages(outputDir, silent = false) {
    return new Promise((resolve, reject) => {
        for (var p of keys(pageData)) {
            try {
                var pageBody = _compilePage(pageData[p], {}, silent);
                var outputPath = path.resolve(pageData[p].path.replace(pagesDir, outputDir) + '.html');

                //doing this stuff synchronously to avoid race conditions
                mkdirp.sync(path.dirname(outputPath));
                fs.writeFileSync(outputPath, pageBody, 'utf8');
            } catch (err) {
                reject(err);
                return;
            }
        }
        return resolve();
    });
}

function _setupCosmia(srcFolder, silent = false, customData = {}) {

    srcDir = srcFolder;
    partialsDir = path.resolve(srcFolder, COSMIA_PARTIAL_PATH);
    dataDir = path.resolve(srcFolder, COSMIA_DATA_PATH);
    layoutsDir = path.resolve(srcFolder, COSMIA_LAYOUT_PATH);
    helpersDir = path.resolve(srcFolder, COSMIA_HELPERS_PATH);
    pagesDir = path.resolve(srcFolder, COSMIA_PAGES_PATH);
    collectionsDir = path.resolve(srcFolder, COSMIA_COLLECTIONS_PATH);

    return Promise.all(
        _registerAppComponents() //,
        //_processDirectory(pagesDir, EXTENSION_HBS, _processPage),
        //_processDirectory(collectionsDir, EXTENSION_JSON, _processCollectionData) //collections overwrite pages
    ).then(() => {
        siteData = Object.assign({}, siteData, customData);
        if (!silent) {
            console.log(`${PACKAGE_NAME}: data extracted`);
        }
    }).catch((err) => {
        console.log(err);
    });
}

function _setup(srcFolder, customData) {
    return _setupCosmia(srcFolder, true, customData).catch((err) => {
        console.error(chalk.red(err));
    });
}

function _compileSite(distFolder) {
    return _compilePages(distFolder)
        .catch((err) => {
            console.error(chalk.red(err));
        });
}

function _cosmia(srcFolder, distFolder, customData = {}) {
    _setup(srcFolder, customData).then(() => {
        //_compileSite(distFolder);
    });
}

_cosmia.setup = _setup;
_cosmia.compileSite = _compileSite;
_cosmia.compilePage = function (pageName, customData = {}) {
    return _compilePage(pageData[pageName], customData, true);
};

module.exports = _cosmia;
