import * as vscode from 'vscode';
import { CheckInData } from './checkInProvider';
import { WebSocketClient } from './webSocketClient';

/**
 * Provider for rendering check-ins with larger avatars in a custom webview
 */
export class LargerAvatarsProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'yna.largerAvatarsView';
    private _view?: vscode.WebviewView;
    private checkIns: CheckInData[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private webSocketClient: WebSocketClient
    ) {
        // Listen for new check-ins
        this.webSocketClient.onMessageReceived(message => {
            const checkIn: CheckInData = {
                username: message.username,
                tags: message.tags,
                message: message.message,
                timestamp: message.timestamp,
                avatarUrl: message.avatarUrl
            };
            this.addCheckIn(checkIn);
        });

        // Listen for history received
        this.webSocketClient.onHistoryReceived(() => {
            this.updateView();
        });
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(message => {
            if (message.command === 'viewProfile') {
                vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${message.username}`));
            }
        });

        // Update view when it becomes visible
        if (this._view?.visible) {
            this.updateView();
        }
    }

    public addCheckIn(checkIn: CheckInData) {
        // Check if this check-in already exists
        const existingIndex = this.checkIns.findIndex(c => 
            c.username === checkIn.username && c.timestamp === checkIn.timestamp
        );

        if (existingIndex !== -1) {
            // Update existing check-in
            this.checkIns[existingIndex] = checkIn;
        } else {
            // Add new check-in to the beginning of the array
            this.checkIns.unshift(checkIn);
            
            // Limit the number of check-ins to prevent performance issues
            if (this.checkIns.length > 100) {
                this.checkIns = this.checkIns.slice(0, 100);
            }
        }

        this.updateView();
    }

    public updateView() {
        if (this._view) {
            this._view.webview.postMessage({
                command: 'updateCheckIns',
                checkIns: this.checkIns
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Get styles URI
        const styleResetUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css')
        );
        const styleVSCodeUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css')
        );
        const styleMainUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css')
        );

        // Use a nonce to only allow specific scripts to be run
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src https: data:; script-src 'nonce-${nonce}';">
    <link href="${styleResetUri}" rel="stylesheet">
    <link href="${styleVSCodeUri}" rel="stylesheet">
    <link href="${styleMainUri}" rel="stylesheet">
    <title>YNA Check-ins</title>
    <style>
        .check-in {
            display: flex;
            padding: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .avatar {
            width: 48px;
            height: 48px;
            border-radius: 50%;
            margin-right: 12px;
            flex-shrink: 0;
        }
        .info {
            flex: 1;
            display: flex;
            flex-direction: column;
        }
        .username {
            font-weight: bold;
            font-size: 14px;
            margin-bottom: 4px;
        }
        .tags {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
        .message {
            font-size: 13px;
            margin-bottom: 4px;
        }
        .timestamp {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .container {
            max-height: 100%;
            overflow-y: auto;
        }
        .placeholder {
            padding: 20px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }
        .status-count {
            padding: 8px 10px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            border-bottom: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-editor-background);
            position: sticky;
            top: 0;
            z-index: 10;
        }
    </style>
</head>
<body>
    <div class="container" id="check-ins-container">
        <div class="placeholder">Loading check-ins...</div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const container = document.getElementById('check-ins-container');

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'updateCheckIns') {
                updateCheckInsList(message.checkIns);
            }
        });

        function updateCheckInsList(checkIns) {
            // Clear container
            container.innerHTML = '';
            
            if (!checkIns || checkIns.length === 0) {
                container.innerHTML = '<div class="placeholder">No check-ins yet. Use "You're Not Alone: Check In" to add one.</div>';
                return;
            }

            // Sort check-ins by timestamp in descending order (newest first)
            const sortedCheckIns = [...checkIns].sort((a, b) => 
                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            );

            // Add status count
            const statusElement = document.createElement('div');
            statusElement.className = 'status-count';
            statusElement.textContent = \`Showing the \${sortedCheckIns.length} most recent check-ins\`;
            container.appendChild(statusElement);

            // Add each check-in
            sortedCheckIns.forEach(checkIn => {
                const checkInElement = document.createElement('div');
                checkInElement.className = 'check-in';
                
                const timestamp = new Date(checkIn.timestamp);
                const timeString = timestamp.toLocaleTimeString();
                
                // Default avatar if none provided
                const avatarUrl = checkIn.avatarUrl || 'https://github.com/github.png';
                
                // Create HTML for this check-in
                checkInElement.innerHTML = \`
                    <img class="avatar" src="\${avatarUrl}" alt="\${checkIn.username}" 
                        title="View \${checkIn.username}'s profile" data-username="\${checkIn.username}">
                    <div class="info">
                        <div class="username">\${checkIn.username}</div>
                        \${checkIn.tags.length > 0 ? 
                            \`<div class="tags">Working on \${checkIn.tags.join(', ')}</div>\` : 
                            ''}
                        \${checkIn.message ? 
                            \`<div class="message">\${checkIn.message}</div>\` : 
                            ''}
                        <div class="timestamp">\${timeString}</div>
                    </div>
                \`;
                
                // Add click handler for avatar
                const avatar = checkInElement.querySelector('.avatar');
                avatar.addEventListener('click', () => {
                    vscode.postMessage({
                        command: 'viewProfile',
                        username: checkIn.username
                    });
                });
                
                container.appendChild(checkInElement);
            });
        }
    </script>
</body>
</html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
} 