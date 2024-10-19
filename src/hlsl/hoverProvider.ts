'use strict';

import { HoverProvider, Hover, SymbolInformation, SymbolKind, MarkdownString, TextDocument, CancellationToken, Range, Position, Uri, ViewColumn, Disposable, commands, window, workspace, WebviewPanel } from 'vscode';
import { HTML_TEMPLATE } from './html';
import hlslGlobals = require('./hlslGlobals');
import { https } from 'follow-redirects';
import { JSDOM } from 'jsdom';

export function textToMarkedString(text: string): MarkdownString {
	return new MarkdownString(text.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&')); // escape markdown syntax tokens: http://daringfireball.net/projects/markdown/syntax#backslash
}

export function linkToMarkdownString(linkUrl: string): MarkdownString {
    if (linkUrl === undefined || linkUrl === '') {
        return;
    }

    let link = new MarkdownString('[HLSL documentation][1]\n\n[1]: ');
    let openDocOnSide = workspace.getConfiguration('hlsl').get<boolean>('openDocOnSide', false);
    if (openDocOnSide) {
        link.appendText(encodeURI( 'command:shader.openLink?' + JSON.stringify([linkUrl, true])));
    } else {
        link.appendText(linkUrl);
    }
    link.isTrusted = true;
    return link;
}

export default class HLSLHoverProvider implements HoverProvider {

    private _subscriptions: Disposable[] = [];
    private _panel: WebviewPanel = null;

    private getSymbols(document: TextDocument): Thenable<SymbolInformation[]> {
        return commands.executeCommand<SymbolInformation[]>('vscode.executeDocumentSymbolProvider', document.uri);
    }

    constructor() {
        this._subscriptions.push( commands.registerCommand('shader.openLink', (link: string, newWindow: boolean) => {
            if (!this._panel) {
                this._panel = window.createWebviewPanel(
                    'hlsldoc',
                    'HLSL Documentation',
                    newWindow ? ViewColumn.Two : ViewColumn.Active,
                    {
                        // Enable scripts in the webview
                        enableScripts: true
                    }
                );

                this._panel.onDidDispose( () => {
                    this._panel = null;
                });

                this._panel.webview.onDidReceiveMessage(
                    message => {
                        switch (message.command) {
                            case 'clickLink':
                                commands.executeCommand('shader.openLink', message.text);
                                return;
                        }
                    }
                );
            }
            this._panel.reveal();
            // And set its HTML content
            getWebviewContent(link).then(html => this._panel.webview.html = html);
        }));

    }

    dispose() {
        this._subscriptions.forEach(s => {s.dispose()});
    }


    public async provideHover(document: TextDocument, position: Position, token: CancellationToken): Promise<Hover> {

        let enable = workspace.getConfiguration('hlsl').get<boolean>('suggest.basic', true);
        if (!enable) {
            return null;
        }

        let wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {
            return null;
        }

        let name = document.getText(wordRange);
        let backchar = '';
        if(wordRange.start.character > 0) {
            let backidx = wordRange.start.translate({characterDelta: -1});
            backchar = backidx.character < 0 ? '' : document.getText(new Range(backidx, wordRange.start));
        }

        if (backchar === '#') {
            const key = name.substring(1);
            var entry = hlslGlobals.preprocessors[name.toUpperCase()];
            if (entry && entry.description) {
                let signature = '(*preprocessor*) ';
                signature += '**#' + name + '**';
                let contents: MarkdownString[] = [];
                contents.push(new MarkdownString(signature));
                contents.push(textToMarkedString(entry.description));
                contents.push(linkToMarkdownString(entry.link));
                return new Hover(contents, wordRange);
            }
        }

        var entry = hlslGlobals.intrinsicfunctions[name]
        if (entry && entry.description) {
            let signature = '(*function*) ';
            signature += '**' + name + '**';
            signature += '(';
            if (entry.parameters && entry.parameters.length != 0) {
                let params = '';
                entry.parameters.forEach(p => params += p.label + ',');
                signature += params.slice(0, -1);
            }
            signature += ')';
            let contents: MarkdownString[] = [];
            contents.push(new MarkdownString(signature));
            contents.push(textToMarkedString(entry.description));
            contents.push(linkToMarkdownString(entry.link));
            return new Hover(contents, wordRange);
        }

        entry = hlslGlobals.datatypes[name];
        if (entry && entry.description) {
            let signature = '(*datatype*) ';
            signature += '**' + name + '**';
            let contents: MarkdownString[] = [];
            contents.push(new MarkdownString(signature));
            contents.push(textToMarkedString(entry.description));
            contents.push(linkToMarkdownString(entry.link));
            return new Hover(contents, wordRange);
        }

        entry = hlslGlobals.semantics[name.toUpperCase()];
        if (entry && entry.description) {
            let signature = '(*semantic*) ';
            signature += '**' + name + '**';
            let contents: MarkdownString[] = [];
            contents.push(new MarkdownString(signature));
            contents.push(textToMarkedString(entry.description));
            contents.push(linkToMarkdownString(entry.link));
            return new Hover(contents, wordRange);
        }

        let key = name.replace(/\d+$/, '') //strip tailing number
        entry = hlslGlobals.semanticsNum[key.toUpperCase()];
        if (entry && entry.description) {
            let signature = '(*semantic*) ';
            signature += '**' + name + '**';
            let contents: MarkdownString[] = [];
            contents.push(new MarkdownString(signature));
            contents.push(textToMarkedString(entry.description));
            contents.push(linkToMarkdownString(entry.link));
            return new Hover(contents, wordRange);
        }

        entry = hlslGlobals.keywords[name];
        if (entry) {
            let signature = '(*keyword*) ';
            signature += '**' + name + '**';
            let contents: MarkdownString[] = [];
            contents.push(new MarkdownString(signature));
            contents.push(textToMarkedString(entry.description));
            contents.push(linkToMarkdownString(entry.link));
            return new Hover(contents, wordRange);
        }

        let symbols = await this.getSymbols(document);

        for (let s of symbols) {
            if (s.name === name) {
                let contents: MarkdownString[] = [];
                let signature = '(*' + SymbolKind[s.kind].toLowerCase() + '*) ';
                signature += s.containerName ? s.containerName + '.' : '';
                signature += '**' + name + '**';

                contents.push(new MarkdownString(signature));

                if (s.location.uri.toString() === document.uri.toString()) {
                    //contents = [];
                    const newValue = new MarkdownString();
                    newValue.appendCodeblock(document.getText(s.location.range), "hlsl");
                    contents.push(newValue);
                }

                return new Hover(contents, wordRange);
            }
        }
    }
}

function getWebviewContent(link: string): Promise<string> {
    const uri = Uri.parse(link);
    return new Promise<string>((resolve, reject) => {
        let request = https.request({
            host: uri.authority,
            path: uri.path,
            rejectUnauthorized: workspace.getConfiguration().get("http.proxyStrictSSL", true)
        }, (response) => {
            if (response.statusCode == 301 || response.statusCode == 302)
                return resolve(response.headers.location);
            if (response.statusCode != 200)
                return resolve(response.statusCode.toString());
            let html = '';
            response.on('data', (data) => { html += data.toString(); });
            response.on('end', () => {
                const dom = new JSDOM(html);
                let topic = '';
                let node = dom.window.document.querySelector('.content');
                if (node) {
                    let num = node.getElementsByTagName('a').length;
                    for (let i = 0; i < num; ++i) {
                        const href = node.getElementsByTagName('a')[i].href;
                        const fulllink = new dom.window.URL(href, uri.toString()).href
                        node.getElementsByTagName('a')[i].href = '#';
                        node.getElementsByTagName('a')[i].setAttribute('onclick', `clickLink('${fulllink}')`)
                    }
                    node.querySelector('.metadata.page-metadata')?.remove();
                    node.querySelector('#center-doc-outline')?.remove();
                    topic = node.outerHTML;

                } else {
                    let link = uri.with({ scheme: 'https' }).toString();
                    topic = `<a href="${link}">No topic found, click to follow link</a>`;
                }
                resolve(HTML_TEMPLATE.replace('{0}', topic));
            });
            response.on('error', (error) => { console.log(error); });
        });
        request.on('error', (error) => { console.log(error) });
        request.end();
    });
}
