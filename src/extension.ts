// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import TextmateLanguageService, { TextmateToken } from 'vscode-textmate-languageservice';

const { getScopeInformationAtPosition, getScopeRangeAtPosition } = TextmateLanguageService.api;

var CONFIG: {relevantScopes: string[], excludeScopes: string[], zeroWidthLandings: string[], debugLog: boolean};

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	CONFIG = vscode.workspace.getConfiguration('semTab') as unknown as {
		relevantScopes: string[],
		excludeScopes: string[],
		zeroWidthLandings: string[],
		debugLog: boolean
	};

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	debug('semtab.lifecycle:active');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposables = [
		// register('semtab.hiThere', alertWithDocText),
		register('semtab.nextToken', selectNextToken),
		register('semtab.previousToken', selectPreviousToken)
	];

	debug(`semtab.lifecycle:configured:${JSON.stringify(CONFIG)}`);

	context.subscriptions.push(...disposables);
}

const register = (name: string, fn: () => void): vscode.Disposable => {
	debug(`semtab.register:${name}`);
	const registration = vscode.commands.registerCommand(name, () => {
		debug(`semtab.invoke:${name}`);
		fn();
	});
	return registration;
};

const debug = (...params: any) => {
	if(CONFIG.debugLog){
		console.log(...params);
	}
};

enum Direction {
	previous = -1,
	next = 1
}

type TokenWithRange<T> = {
	token: T,
	range: vscode.Range
}

const acceptable = (token: TextmateToken): boolean => {
	if (token.text.trim() === ''){
		return false;
	}
	for (var scope of CONFIG.zeroWidthLandings){
		if (token.type === scope || token.type.startsWith(`${scope}.`)){
			return true;
		}
	}
	for (var scope of CONFIG.relevantScopes){
		if (token.type === scope || token.type.startsWith(`${scope}.`)){
			debug(`matched token with type ${token.type} to scope ${scope}`);
			for (var exclusion of CONFIG.excludeScopes){
				for (var token_scope of token.scopes){
					if (token.type === exclusion || token.type.startsWith(`${exclusion}.`)){
						debug(`excluded token of type ${token.type} from matching because ${token_scope} is a match for ${exclusion}`);
						return false;
					}
				}
			}
			return true;
		} else {
			debug(`could not match token of type ${token.type} to scope ${scope}`);
		}
	}
	return false;
};



const getToken = async (doc: vscode.TextDocument, position: vscode.Position): Promise<TokenWithRange<TextmateToken>> => {
	const token = await getScopeInformationAtPosition(doc, position);
	if (token === undefined){
		throw new Error("no token at given position");
	} else {
		debug(JSON.stringify(token));
	}
	const tokenRange = await getScopeRangeAtPosition(doc, position);
	return {
		token: token,
		range: tokenRange
	};
};

const followingPosition = (doc: vscode.TextDocument, boundaryPosition: vscode.Position, direction: Direction, trailsKnownToken: boolean = false) : [vscode.Position, boolean] => {
	debug(`getting following position for ${boundaryPosition.line},${boundaryPosition.character}`);
	if (direction === Direction.next){
		// using the document to check whether this character is valid fails because it doesn't
		// actually check whether the character position exceeds the line length
		const charFollowingInLine = trailsKnownToken ? boundaryPosition : boundaryPosition.translate({characterDelta: direction});
		if (!doc.lineAt(charFollowingInLine.line).range.contains(charFollowingInLine)){
			const nextLineIndex = boundaryPosition.line + 1
			if (doc.lineCount > nextLineIndex) {
				return [doc.lineAt(nextLineIndex).range.start, false];
			} else {
				return [doc.lineAt(0).range.start, true];
			}
		} else {
			return [charFollowingInLine, false];
		}
	} else {
		try {
			// translating to a negative character in a line throws
			return [boundaryPosition.translate({characterDelta: direction}), false];
		} catch {
			const previousLineNumber = boundaryPosition.translate({lineDelta: direction}).line;
			if (previousLineNumber > 0) {
				return [doc.lineAt(previousLineNumber).range.end, false];
			} else {
				return [doc.lineAt(doc.lineCount - 1).range.end, true];
			}
		}
	}
};

const boundaryPositionOfToken = (token: TokenWithRange<TextmateToken>, direction: Direction) => {
	return direction === Direction.next ? token.range.end : token.range.start;
};

const loopingInfinitely = (initialPosition: vscode.Position, currentPosition: vscode.Position, direction: Direction, hasWrapped: boolean) => {
	debug('checking loop status for ', initialPosition, currentPosition, direction, hasWrapped);
	if (!hasWrapped){
		return false;
	} else {
		if (direction === Direction.next) {
			return (currentPosition.line > initialPosition.line) || (currentPosition.line === initialPosition.line && currentPosition.character >= initialPosition.character) ;
		} else {
			return (currentPosition.line < initialPosition.line) || (currentPosition.line === initialPosition.line && currentPosition.character <= initialPosition.character) ;
		}
	}
}

const nextToken = async (doc: vscode.TextDocument, position: vscode.Position, direction: Direction) => {
	debug(`initial position: ${position.line},${position.character}`);
	var homingPosition = position;
	var positionToTry : null | vscode.Position = null;
	var wrapped = false;
	var wrappedAtLeastOnce = false;
	while (!loopingInfinitely(position, homingPosition, direction, wrappedAtLeastOnce) && positionToTry === null){
		try {
			const tokenAtThisPosition = await getToken(doc, homingPosition);
			const boundaryPosition = boundaryPositionOfToken(tokenAtThisPosition, direction);
			if(direction === Direction.previous){
				[positionToTry, wrapped] = followingPosition(doc, boundaryPosition, direction, true);
			} else {
				positionToTry = boundaryPosition;
			}
		} catch {
			[homingPosition, wrapped] = followingPosition(doc, homingPosition, direction);
		}
		wrappedAtLeastOnce = wrapped || wrappedAtLeastOnce;
	}
	if (positionToTry === null){
		throw new Error('wrapped around; never found token');
	}
	while (!loopingInfinitely(position, positionToTry, direction, wrappedAtLeastOnce)){
		try {
			var foundToken = await getToken(doc, positionToTry);
			if(acceptable(foundToken.token)){
				return foundToken;
			} else {
				[positionToTry, wrapped] = followingPosition(doc, boundaryPositionOfToken(foundToken, direction), direction, true);
			}
		} catch {
			[positionToTry, wrapped] = followingPosition(doc, positionToTry, direction);
		}
		wrappedAtLeastOnce = wrapped || wrappedAtLeastOnce;
	}
	throw new Error('wrapped around; never found a token');

};

const highlightToken = (editor: vscode.TextEditor, token: TokenWithRange<TextmateToken>, direction: Direction) => {
	for (var scope of CONFIG.zeroWidthLandings){
		if (token.token.type === scope || token.token.type.startsWith(`${scope}.`)){
			editor.selection = new vscode.Selection(token.range.start, token.range.start);
			return;
		}
	}
	if(direction === Direction.next){
		editor.selection = new vscode.Selection(token.range.start, token.range.end);
	} else {
		editor.selection = new vscode.Selection(token.range.end, token.range.start);
	}
}

const selectToken = async (direction: Direction) => {
	const editor = vscode.window.activeTextEditor;
	if (!editor){
		return;
	}
	var position: vscode.Position;
	if (editor.selection.isEmpty){
		position = editor.selection.active;
	} else {
		position = editor.selection.start;
	}
	const moveToToken = await nextToken(editor.document, position, direction);
	debug(`found next token to move to: ${JSON.stringify(moveToToken)}`);
	editor.revealRange(moveToToken.range);

	highlightToken(editor, moveToToken, direction);
};

const selectNextToken = async () => {
	await selectToken(Direction.next);
};

const selectPreviousToken = async () => {
	await selectToken(Direction.previous);
};

// This method is called when your extension is deactivated
export function deactivate() {}
