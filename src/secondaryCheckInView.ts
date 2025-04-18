import * as vscode from 'vscode';
import { WebSocketClient } from './webSocketClient';
import fetch from 'node-fetch';
import { FileHistoryTracker } from './fileHistoryTracker';
import { getActiveFileTags } from './tagsUtils';

/**
 * Interface for check-in data
 */
export interface CheckInData {
    username: string;
    tags: string[];
    message: string;
    timestamp: string;
    avatarUrl?: string;
    snippet?: string;
}

/**
 * Manages the webview in the secondary sidebar
 */
export class SecondaryCheckInView implements vscode.WebviewViewProvider {
    public static readonly viewType = 'yna.checkInView';
    private _view?: vscode.WebviewView;
    private checkIns: CheckInData[] = [];
    private webviewReady = false;
    private pendingCheckIns: CheckInData[] = [];
    private readyMessageReceived = false;
    private onlineUsersCount = 0;
    private newCheckInsCount = 0; // Track new check-ins since last view
    private _onCheckInsCountChanged = new vscode.EventEmitter<number>();
    
    // Event that fires when check-ins count changes
    public readonly onCheckInsCountChanged = this._onCheckInsCountChanged.event;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private webSocketClient: WebSocketClient,
        private readonly _context: vscode.ExtensionContext
    ) {
        // Listen for connection status changes
        this.webSocketClient.onConnectionStatusChanged(connected => {
            if (this._view && this.webviewReady) {
                this._view.webview.postMessage({
                    command: 'connectionStatus',
                    connected
                });
            }
            
            // Request online users count when connected
            if (connected) {
                this.webSocketClient.requestOnlineUsers();
            }
        });

        // Listen for new check-ins
        this.webSocketClient.onMessageReceived(message => {
            const checkIn: CheckInData = {
                username: message.username,
                tags: message.tags,
                message: message.message,
                timestamp: message.timestamp,
                avatarUrl: message.avatarUrl,
                snippet: message.snippet
            };
            this.addCheckIn(checkIn);
        });

        // Listen for history received
        this.webSocketClient.onHistoryReceived(() => {
            this.updateView();
        });
        
        // Listen for online users count changes
        this.webSocketClient.onOnlineUsersChanged(count => {
            this.onlineUsersCount = count;
            this.updateOnlineUsersCount();
        });
        
        // Listen for cooldown changes
        this.webSocketClient.onCooldownChanged(remainingMs => {
            this.updateCooldownStatus(remainingMs);
        });

        // Every 2 seconds, retry sending any pending check-ins to the webview
        setInterval(() => {
            if (this.webviewReady && this.pendingCheckIns.length > 0) {
                const checkInsToSend = [...this.pendingCheckIns];
                this.pendingCheckIns = [];
                
                checkInsToSend.forEach(checkIn => {
                    this.addCheckIn(checkIn);
                });
            }
        }, 2000);
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        this.webviewReady = false;
        this.readyMessageReceived = false;
        
        // Reset new check-ins counter when view is opened
        this.resetNewCheckInsCount();
        
        // Hide status bar notification if it exists
        vscode.commands.executeCommand('yna.hideStatusBarNotification');
        
        // Check for authentication and update UI
        this.checkAuthAndUpdateUI();
        
        // Monitor view visibility changes
        this._view.onDidChangeVisibility(() => {
            if (this.isVisible()) {
                // Reset counter and hide notification when view becomes visible
                this.resetNewCheckInsCount();
                vscode.commands.executeCommand('yna.hideStatusBarNotification');
                
                // Refresh authentication status when view becomes visible
                this.checkAuthAndUpdateUI();
            }
        });

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(message => {
            if (message.command === 'viewProfile') {
                vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${message.username}`));
            } else if (message.command === 'checkIn') {
                this.handleCheckIn(message.message);
            } else if (message.command === 'logout') {
                // Execute the logout command
                vscode.commands.executeCommand('yna.logout');
                
                // Update UI after logout
                setTimeout(() => this.checkAuthAndUpdateUI(), 500);
            } else if (message.command === 'login') {
                // Handle login request
                this.handleLogin();
            } else if (message.command === 'ready') {
                this.webviewReady = true;
                this.readyMessageReceived = true;
                
                // Send authentication status to webview
                this.checkAuthAndUpdateUI();
                
                // If authenticated and we have existing check-ins, update the view immediately
                this.getAuthenticatedGitHubUsername().then(username => {
                    if (username && this.checkIns.length > 0) {
                        this.updateView();
                    } else if (username) {
                        // Force a request for history
                        this.webSocketClient.requestHistory();
                    }
                });
            }
        });

        // Ensure the webview gets marked ready after a timeout even if the ready event is missed
        setTimeout(() => {
            if (!this.readyMessageReceived) {
                this.webviewReady = true;
                
                // Check authentication and update UI
                this.checkAuthAndUpdateUI();
                
                // If authenticated and we have existing check-ins, update the view
                this.getAuthenticatedGitHubUsername().then(username => {
                    if (username && this.checkIns.length > 0) {
                        this.updateView();
                    } else if (username) {
                        // Request history if we're authenticated but don't have any check-ins
                        this.webSocketClient.requestHistory();
                    }
                });
            }
        }, 3000);

        // Get any check-ins already received by the WebSocketClient if we're authenticated
        this.getAuthenticatedGitHubUsername().then(username => {
            if (username) {
                const existingCheckIns = this.webSocketClient.getAllCheckIns();
                
                existingCheckIns.forEach(checkIn => {
                    this.addCheckIn({
                        username: checkIn.username,
                        tags: checkIn.tags,
                        message: checkIn.message,
                        timestamp: checkIn.timestamp,
                        avatarUrl: checkIn.avatarUrl,
                        snippet: checkIn.snippet
                    });
                });
            }
        });
    }

    public addCheckIn(checkIn: CheckInData) {
        try {
            // Check if this user already has a check-in
            const existingIndex = this.checkIns.findIndex(c => c.username === checkIn.username);
            let isNewOrUpdated = false;
    
            if (existingIndex !== -1) {
                // Only update if the new check-in is newer
                const existingTimestamp = new Date(this.checkIns[existingIndex].timestamp).getTime();
                const newTimestamp = new Date(checkIn.timestamp).getTime();
                
                if (newTimestamp > existingTimestamp) {
                    this.checkIns[existingIndex] = checkIn;
                    isNewOrUpdated = true;
                } else {
                    return; // Don't update or refresh view with older data
                }
            } else {
                // Add new check-in
                this.checkIns.push(checkIn);
                isNewOrUpdated = true;
                
                // Limit the number of check-ins stored in memory
                if (this.checkIns.length > 100) {
                    this.checkIns = this.checkIns.slice(0, 100);
                }
            }
            
            // If this is a new or updated check-in and the view isn't visible, increment the counter
            if (isNewOrUpdated && !this.isVisible()) {
                this.newCheckInsCount++;
                // Notify extension that we have new check-ins
                vscode.commands.executeCommand('yna.notifyNewCheckIn');
            }
            
            // If the check-ins count has changed, notify listeners
            if (isNewOrUpdated) {
                this._onCheckInsCountChanged.fire(this.checkIns.length);
            }
    
            // If the webview is ready, update it. Otherwise, store the check-in for later
            if (this.webviewReady) {
                this.updateView();
            } else {
                // Store in pending list to send later
                if (!this.pendingCheckIns.some(c => c.username === checkIn.username)) {
                    this.pendingCheckIns.push(checkIn);
                }
            }
        } catch (error) {
            console.error("Error adding check-in to panel:", error);
        }
    }

    public updateView() {
        if (this._view && this.webviewReady) {
            try {
                // Sort check-ins by timestamp (newest first) before sending to the webview
                const sortedCheckIns = [...this.checkIns].sort((a, b) => {
                    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
                });
                
                this._view.webview.postMessage({
                    command: 'updateCheckIns',
                    checkIns: sortedCheckIns
                });
                
                // Also update online users count
                this.updateOnlineUsersCount();
                
                // If the checkIns were pending, clear them now
                this.pendingCheckIns = [];
            } catch (error) {
                console.error("Error updating view:", error);
            }
        } else {
            // Ensure we try again later if webview is not ready
            if (!this.webviewReady && this.checkIns.length > 0) {
                this.checkIns.forEach(checkIn => {
                    if (!this.pendingCheckIns.some(c => c.username === checkIn.username)) {
                        this.pendingCheckIns.push(checkIn);
                    }
                });
            }
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

        // Use a nonce to only allow specific scripts to be run
        const nonce = this.getNonce();

        // Stage 1: Clean up the existing UI while keeping functionality
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src https:; script-src 'nonce-${nonce}';">
    <link href="${styleResetUri}" rel="stylesheet">
    <link href="${styleVSCodeUri}" rel="stylesheet">
    <title>You're Not Alone</title>
    <style>
        body { 
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            margin: 0;
            padding: 0;
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .header {
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-sideBar-background);
            font-weight: bold;
        }
        .check-ins-container {
            flex: 1;
            overflow-y: auto;
            padding: 0;
        }
        .check-ins-list {
            list-style-type: none;
            margin: 0;
            padding: 0;
        }
        .check-in-item {
            padding: 10px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .check-in-header {
            display: flex;
            justify-content: space-between;
            margin-bottom: 6px;
        }
        .user-info {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .avatar {
            width: 30px;
            height: 30px;
            border-radius: 50%;
            background-color: var(--vscode-badge-background);
        }
        .username {
            font-weight: bold;
        }
        .timestamp {
            color: var(--vscode-descriptionForeground);
            font-size: 0.85em;
        }
        .tags {
            margin: 5px 0;
        }
        .tag {
            display: inline-block;
            padding: 2px 6px;
            margin-right: 4px;
            margin-bottom: 4px;
            border-radius: 4px;
            font-size: 11px;
            color: white;
            background-color: var(--vscode-badge-background);
        }
        /* Position-based tag colors instead of language-specific */
        .tag-1 {
            background-color: #717D92;
        }
        .tag-2 {
            background-color: #A69C7D;
        }
        .tag-3 {
            background-color: #82A69C;
        }
        .message {
            margin-top: 5px;
            word-break: break-word;
            padding-left: 8px;
            border-left: 3px solid var(--vscode-textLink-foreground);
            color: var(--vscode-foreground);
            opacity: 0.9;
        }
        .input-area {
            padding: 10px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        .input-container {
            position: relative;
            margin-bottom: 8px;
        }
        .message-input {
            width: 100%;
            padding: 6px 8px 6px 8px;
            padding-right: 30px !important;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            box-sizing: border-box;
            border-radius: 6px;
        }
        .emoji-button {
            position: absolute;
            right: 5px;
            top: 3px;
            background: none;
            border: none;
            cursor: pointer;
            font-size: 16px;
            opacity: 0.7;
            padding: 0;
            z-index: 10;
        }
        .emoji-button:hover {
            opacity: 1;
            background: none;
        }
        .emoji-picker {
            position: absolute;
            bottom: 100%;
            right: 0;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 5px;
            display: none;
            flex-wrap: wrap;
            max-width: 200px;
            max-height: 150px;
            overflow-y: auto;
            z-index: 100;
        }
        .emoji {
            cursor: pointer;
            font-size: 16px;
            padding: 2px;
            margin: 2px;
            transition: transform 0.1s;
        }
        .emoji:hover {
            transform: scale(1.2);
        }
        .code-snippet {
            background-color: var(--vscode-editor-background);
            border-radius: 4px;
            padding: 8px;
            margin: 8px 0;
            border-left: 3px solid var(--vscode-textLink-activeForeground);
        }
        .snippet-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
        .snippet-text {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 12px;
            white-space: pre-wrap;
            overflow-x: auto;
            margin: 0;
            padding: 4px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            border-radius: 2px;
        }
        
        /* New styling for the snippet text as a message */
        .snippet-text {
            font-style: italic;
            font-size: 0.95em;
            padding: 4px 8px;
            margin: 5px 0;
            color: var(--vscode-foreground);
            opacity: 0.9;
        }
        .button-container {
            display: flex;
            justify-content: space-between;
            width: 100%;
            align-items: center;
        }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 10px;
            cursor: pointer;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        #check-in-button {
            background-color: #fcb627;
            color: #111111;
            border-radius: 6px;
        }
        #check-in-button:hover {
            background-color: #e0a01f; /* Slightly darker shade for hover */
        }
        #check-in-button:disabled {
            background-color: #fcb627;
            opacity: 0.5;
        }
        .char-counter {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-left: 10px;
        }
        .char-counter.error {
            color: var(--vscode-errorForeground, #f48771);
        }
        .status {
            padding: 5px 12px;
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .no-check-ins {
            padding: 20px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }
        .header-actions {
            display: flex;
            justify-content: flex-end;
            padding: 2px 12px;
        }
        .logout-button {
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            cursor: pointer;
            padding: 6px 10px;
            opacity: 0.7;
            margin-left: auto;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .logout-button:hover {
            opacity: 1;
            background: none;
        }
        /* Login section styles */
        #login-section {
            display: none;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            padding: 20px;
            text-align: center;
        }
        #login-section h3 {
            margin-bottom: 20px;
            font-size: 1.2em;
        }
        #login-section p {
            margin-bottom: 25px;
            color: var(--vscode-descriptionForeground);
        }
        #login-button {
            background-color: #2ea44f;
            color: white;
            padding: 8px 16px;
            border-radius: 6px;
            display: flex;
            align-items: center;
            gap: 8px;
            font-weight: bold;
        }
        #login-button:hover {
            background-color: #2c974b;
        }
        #login-button svg {
            width: 20px;
            height: 20px;
        }
        #main-content {
            display: flex;
            flex-direction: column;
            height: 100%;
        }
    </style>
</head>
<body>
    <div id="login-section">
        <h3>You're Not Alone</h3>
        <p>Sign in with GitHub to check in and see who else is coding right now.</p>
        <button id="login-button">
            <svg viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
            </svg>
            Sign in with GitHub
        </button>
    </div>

    <div id="main-content">
        <!-- Removing redundant header -->
        <div class="status" id="status">Loading...</div>
        
        <div class="check-ins-container">
            <div class="no-check-ins" id="placeholder">Loading check-ins...</div>
            <ul class="check-ins-list" id="check-ins"></ul>
        </div>
        
        <div class="input-area">
            <div class="input-container">
                <input type="text" id="message-input" class="message-input" placeholder="What's on your mind?">
                <button id="emoji-button" class="emoji-button" title="Add emoji">😊</button>
                <div id="emoji-picker" class="emoji-picker" style="display: none;"></div>
            </div>
            <div class="button-container">
                <button id="check-in-button">Check In</button>
                <span class="char-counter" id="char-counter">42 chars left</span>
                <button class="logout-button" id="logout-button" title="Logout">logout ⏻</button>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        (function() {
            try {
                // DOM elements
                const statusElement = document.getElementById('status');
                const checkInsElement = document.getElementById('check-ins');
                const placeholderElement = document.getElementById('placeholder');
                const messageInput = document.getElementById('message-input');
                const checkInButton = document.getElementById('check-in-button');
                const logoutButton = document.getElementById('logout-button');
                const emojiButton = document.getElementById('emoji-button');
                const emojiPicker = document.getElementById('emoji-picker');
                const charCounter = document.getElementById('char-counter');
                const loginSection = document.getElementById('login-section');
                const mainContent = document.getElementById('main-content');
                const loginButton = document.getElementById('login-button');
                
                // Authentication state
                let isAuthenticated = false;
                
                // Character limit constants
                const MAX_CHARS = 42;
                
                // Cooldown state
                let isOnCooldown = false;
                let cooldownTimer = null;
                
                // Update character counter function
                function updateCharCounter() {
                    // If on cooldown, don't update the counter
                    if (isOnCooldown) {
                        return;
                    }
                    
                    const textLength = messageInput.value.length;
                    const remaining = MAX_CHARS - textLength;
                    charCounter.textContent = remaining + " chars left";
                    
                    // Apply error styles if over limit
                    if (remaining < 0) {
                        charCounter.classList.add('error');
                        checkInButton.disabled = true;
                    } else {
                        charCounter.classList.remove('error');
                        checkInButton.disabled = false;
                    }
                }
                
                // Start cooldown UI updates
                function startCooldown(remainingMs, formattedTime) {
                    isOnCooldown = true;
                    
                    // Disable input and button
                    messageInput.disabled = true;
                    checkInButton.disabled = true;
                    emojiButton.disabled = true;
                    
                    // Close emoji picker if open
                    emojiPicker.style.display = 'none';
                    
                    // Update counter with remaining time
                    updateCooldownDisplay(formattedTime);
                    
                    // Clear any existing timer
                    if (cooldownTimer) {
                        clearInterval(cooldownTimer);
                    }
                }
                
                // Update cooldown display
                function updateCooldownDisplay(formattedTime) {
                    charCounter.textContent = \`Available in \${formattedTime}\`;
                    charCounter.classList.remove('error');
                }
                
                // End cooldown
                function endCooldown() {
                    isOnCooldown = false;
                    
                    // Re-enable input and button
                    messageInput.disabled = false;
                    checkInButton.disabled = false;
                    emojiButton.disabled = false;
                    
                    // Update character counter
                    updateCharCounter();
                    
                    // Clear the timer
                    if (cooldownTimer) {
                        clearInterval(cooldownTimer);
                        cooldownTimer = null;
                    }
                }
                
                // Toggle between login and main content views
                function updateAuthUI(authenticated) {
                    isAuthenticated = authenticated;
                    if (authenticated) {
                        loginSection.style.display = 'none';
                        mainContent.style.display = 'flex';
                    } else {
                        loginSection.style.display = 'flex';
                        mainContent.style.display = 'none';
                    }
                }
                
                // Listen for input events to update counter
                messageInput.addEventListener('input', updateCharCounter);
                
                // Initialize counter
                updateCharCounter();
                
                // Initialize emoji picker
                const commonEmojis = [
                '😅',
                '🤯',
                '🤘',
                '🧠',
                '👀',
                '🤔',
                '🐛',
                '🚧',
                '🛠️',
                '⌛',
                '💻',
                '🚀',
                '🔥',
                '✅',
                '🎯',
                '👏',
                '🙌',
                '🤝',
                '🧡',
                '😎',
                '☕',
                '🍺',
                '🍕'
                ];

                
                // Populate emoji picker
                commonEmojis.forEach(emoji => {
                    const emojiElement = document.createElement('div');
                    emojiElement.className = 'emoji';
                    emojiElement.textContent = emoji;
                    emojiElement.addEventListener('click', () => {
                        // Insert emoji at cursor position
                        messageInput.focus();
                        const position = messageInput.selectionStart || messageInput.value.length;
                        const before = messageInput.value.substring(0, position);
                        const after = messageInput.value.substring(position);
                        messageInput.value = before + emoji + after;
                        
                        // Set cursor position after inserted emoji
                        messageInput.selectionStart = position + emoji.length;
                        messageInput.selectionEnd = position + emoji.length;
                        
                        // Hide picker
                        emojiPicker.style.display = 'none';
                    });
                    emojiPicker.appendChild(emojiElement);
                });
                
                // Toggle emoji picker - check if on cooldown first
                emojiButton.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (isOnCooldown) return; // Don't open picker when on cooldown
                    
                    if (emojiPicker.style.display === 'none') {
                        emojiPicker.style.display = 'flex';
                    } else {
                        emojiPicker.style.display = 'none';
                    }
                });
                
                // Close emoji picker when clicking outside
                document.addEventListener('click', (e) => {
                    if (e.target !== emojiButton && e.target !== emojiPicker && !emojiPicker.contains(e.target)) {
                        emojiPicker.style.display = 'none';
                    }
                });
                
                // Connect to VS Code
                try {
                    const vscode = acquireVsCodeApi();
                    
                    // Set up login button
                    loginButton.addEventListener('click', () => {
                        vscode.postMessage({ command: 'login' });
                    });
                    
                    // Set up check-in button
                    checkInButton.addEventListener('click', () => {
                        const message = messageInput.value.trim();
                        
                        // Check if message is within character limit
                        if (message.length <= MAX_CHARS) {
                            vscode.postMessage({ command: 'checkIn', message });
                            messageInput.value = '';
                            updateCharCounter();
                        }
                    });
                    
                    // Set up logout button handler
                    logoutButton.addEventListener('click', () => {
                        vscode.postMessage({ command: 'logout' });
                    });
                    
                    // Enter key to submit
                    messageInput.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            if (messageInput.value.trim().length <= MAX_CHARS) {
                                checkInButton.click();
                            }
                        }
                    });
                    
                    // Handle messages from extension
                    window.addEventListener('message', (event) => {
                        const message = event.data;
                        
                        if (message.command === 'updateCheckIns') {
                            updateCheckInsList(message.checkIns);
                        } else if (message.command === 'connectionStatus') {
                            statusElement.textContent = message.connected ? 
                                'Connected' : 'Reconnecting...';
                            
                            if (!message.connected) {
                                statusElement.style.backgroundColor = '#5a1d1d';
                                checkInButton.disabled = true;
                            } else {
                                statusElement.style.backgroundColor = '';
                                // Only enable if not on cooldown
                                if (!isOnCooldown) {
                                    checkInButton.disabled = false;
                                }
                            }
                        } else if (message.command === 'updateOnlineUsers') {
                            const count = message.count;
                            const checkInsCount = document.querySelectorAll('.check-in-item').length;
                            statusElement.textContent = count > 0 ? 
                                count + " fellow dev" + (count === 1 ? "" : "s") + " with you now • " + checkInsCount + " check-in" + (checkInsCount === 1 ? "" : "s") : 
                                "Showing " + checkInsCount + " check-in" + (checkInsCount === 1 ? "" : "s");
                        } else if (message.command === 'updateCooldown') {
                            const remainingMs = message.remainingMs;
                            const formattedTime = message.formattedTime;
                            
                            if (remainingMs > 0) {
                                startCooldown(remainingMs, formattedTime);
                            } else {
                                endCooldown();
                            }
                        } else if (message.command === 'authStatus') {
                            // Update UI based on authentication status
                            updateAuthUI(message.authenticated);
                        }
                    });
                    
                    // Update check-ins list
                    function updateCheckInsList(checkIns) {
                        if (!checkIns || checkIns.length === 0) {
                            placeholderElement.style.display = 'block';
                            placeholderElement.textContent = 'No check-ins yet';
                            checkInsElement.style.display = 'none';
                            statusElement.textContent = 'No check-ins';
                            return;
                        }
                        
                        placeholderElement.style.display = 'none';
                        checkInsElement.style.display = 'block';
                        
                        // Sort by timestamp (newest first)
                        const sortedCheckIns = [...checkIns].sort((a, b) => {
                            return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
                        });
                        
                        // Update status
                        statusElement.textContent = 'Showing ' + sortedCheckIns.length + ' check-ins';
                        
                        // Clear existing list
                        checkInsElement.innerHTML = '';
                        
                        // Function to calculate time ago
                        function timeAgo(timestamp) {
                            const now = new Date();
                            const checkInTime = new Date(timestamp);
                            const diffMs = now.getTime() - checkInTime.getTime();
                            const diffSec = Math.floor(diffMs / 1000);
                            
                            if (diffSec < 20) return "just now";
                            
                            if (diffSec < 60) return diffSec + ' seconds ago';
                            
                            const diffMin = Math.floor(diffSec / 60);
                            if (diffMin < 60) return diffMin + ' minute' + (diffMin === 1 ? '' : 's') + ' ago';
                            
                            const diffHour = Math.floor(diffMin / 60);
                            if (diffHour < 24) return diffHour + ' hour' + (diffHour === 1 ? '' : 's') + ' ago';
                            
                            const diffDays = Math.floor(diffHour / 24);
                            if (diffDays < 30) return diffDays + ' day' + (diffDays === 1 ? '' : 's') + ' ago';
                            
                            const diffMonths = Math.floor(diffDays / 30);
                            if (diffMonths < 12) return diffMonths + ' month' + (diffMonths === 1 ? '' : 's') + ' ago';
                            
                            const diffYears = Math.floor(diffMonths / 12);
                            return diffYears + ' year' + (diffYears === 1 ? '' : 's') + ' ago';
                        }
                        
                        // Add each check-in
                        sortedCheckIns.forEach((checkIn, index) => {
                            const item = document.createElement('li');
                            item.className = 'check-in-item';
                            
                            // Create header with username and timestamp
                            const header = document.createElement('div');
                            header.className = 'check-in-header';
                            
                            const userInfo = document.createElement('div');
                            userInfo.className = 'user-info';
                            
                            // Add avatar if available
                            if (checkIn.avatarUrl) {
                                const avatar = document.createElement('img');
                                avatar.className = 'avatar';
                                avatar.src = checkIn.avatarUrl;
                                avatar.alt = checkIn.username;
                                avatar.title = 'View GitHub profile';
                                avatar.style.cursor = 'pointer';
                                avatar.onclick = () => {
                                    vscode.postMessage({
                                        command: 'viewProfile',
                                        username: checkIn.username
                                    });
                                };
                                avatar.onerror = function() {
                                    // If avatar loading fails, replace with initials
                                    this.style.display = 'flex';
                                    this.style.alignItems = 'center';
                                    this.style.justifyContent = 'center';
                                    this.style.fontSize = '10px';
                                    this.style.color = 'var(--vscode-badge-foreground)';
                                    this.textContent = checkIn.username.substring(0, 2).toUpperCase();
                                    this.onerror = null;
                                };
                                userInfo.appendChild(avatar);
                            } else {
                                // Create placeholder with initials
                                const avatar = document.createElement('div');
                                avatar.className = 'avatar';
                                avatar.style.display = 'flex';
                                avatar.style.alignItems = 'center';
                                avatar.style.justifyContent = 'center';
                                avatar.style.fontSize = '10px';
                                avatar.style.color = 'var(--vscode-badge-foreground)';
                                avatar.textContent = checkIn.username.substring(0, 2).toUpperCase();
                                avatar.title = 'View GitHub profile';
                                avatar.style.cursor = 'pointer';
                                avatar.onclick = () => {
                                    vscode.postMessage({
                                        command: 'viewProfile',
                                        username: checkIn.username
                                    });
                                };
                                userInfo.appendChild(avatar);
                            }
                            
                            const username = document.createElement('span');
                            username.className = 'username';
                            username.textContent = checkIn.username;
                            username.title = 'View GitHub profile';
                            username.style.cursor = 'pointer';
                            username.onclick = () => {
                                vscode.postMessage({
                                    command: 'viewProfile',
                                    username: checkIn.username
                                });
                            };
                            
                            userInfo.appendChild(username);
                            header.appendChild(userInfo);
                            
                            const timestamp = document.createElement('span');
                            timestamp.className = 'timestamp';
                            timestamp.textContent = timeAgo(checkIn.timestamp);
                            timestamp.title = new Date(checkIn.timestamp).toLocaleString();
                            header.appendChild(timestamp);
                            
                            item.appendChild(header);
                            
                            // Add snippet if available (moved above tags)
                            if (checkIn.snippet && checkIn.snippet.trim()) {
                                const snippetText = document.createElement('div');
                                snippetText.className = 'snippet-text';
                                snippetText.textContent = checkIn.snippet;
                                item.appendChild(snippetText);
                            }
                            
                            // Add tags if present
                            if (checkIn.tags && checkIn.tags.length > 0) {
                                const tagsContainer = document.createElement('div');
                                tagsContainer.className = 'tags';
                                
                                // Display at most 3 tags
                                const tagLimit = Math.min(3, checkIn.tags.length);
                                
                                for (let i = 0; i < tagLimit; i++) {
                                    const tag = document.createElement('span');
                                    tag.className = 'tag tag-' + (i + 1);
                                    tag.textContent = checkIn.tags[i];
                                    tagsContainer.appendChild(tag);
                                }
                                
                                item.appendChild(tagsContainer);
                            }
                            
                            // Add message if present
                            if (checkIn.message && checkIn.message.trim()) {
                                const message = document.createElement('div');
                                message.className = 'message';
                                message.textContent = checkIn.message;
                                item.appendChild(message);
                            }
                            
                            checkInsElement.appendChild(item);
                        });
                    }
                    
                    // Tell the extension we're ready
                    vscode.postMessage({ command: 'ready' });
                    
                } catch (error) {
                    statusElement.textContent = 'Connection error';
                }
                
            } catch (error) {
                console.error('Script error:', error);
                document.body.innerHTML += '<p style="color:red">ERROR: ' + error.toString() + '</p>';
            }
        })();
    </script>
    
    <!-- Fallback content -->
    <noscript>
        <div style="color:red; padding: 20px;">
            <h3>JavaScript Error</h3>
            <p>The webview script failed to load or execute.</p>
        </div>
    </noscript>
</body>
</html>`;

        return html;
    }

    // Handle check-in from the view UI
    private async handleCheckIn(message: string) {
        // Try to get GitHub username using authentication
        const username = await this.getAuthenticatedGitHubUsername();
        
        if (!username) {
            if (this._view) {
                this._view.webview.postMessage({
                    command: 'checkInError',
                    error: 'You need to be signed in to check in'
                });
            }
            return;
        }
        
        // Ensure WebSocket is connected
        if (!this.webSocketClient.isConnected()) {
            this.webSocketClient.reconnect();
            
            // Wait a moment for the connection to establish
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Verify connection
            if (!this.webSocketClient.isConnected()) {
                if (this._view) {
                    this._view.webview.postMessage({
                        command: 'checkInError',
                        error: 'Could not connect to server. Please try again later.'
                    });
                }
                return;
            }
        }
        
        // Check if user is on cooldown
        if (!this.webSocketClient.canCheckIn()) {
            const cooldownTime = this.webSocketClient.getFormattedCooldownTime();
            if (this._view) {
                this._view.webview.postMessage({
                    command: 'checkInError',
                    error: `You can check in again in ${cooldownTime}.`
                });
            }
            return;
        }
        
        // Automatically get the active file's language as tags
        const activeLanguageTags = getActiveFileTags();
        
        // Send check-in to server
        const success = await this.webSocketClient.sendCheckIn(username, activeLanguageTags, message);
        
        // Show result in the webview
        if (this._view) {
            if (success) {
                this._view.webview.postMessage({
                    command: 'checkInSuccess'
                });
                
                // Trigger show temporary message
                if (activeLanguageTags.length > 0) {
                    vscode.commands.executeCommand('yna.showTemporaryMessage', `Checked in as ${username} working on ${activeLanguageTags.join(', ')}`);
                } else {
                    vscode.commands.executeCommand('yna.showTemporaryMessage', `Checked in as ${username}`);
                }
            } else {
                this._view.webview.postMessage({
                    command: 'checkInError',
                    error: 'Check-in failed. Please try again later.'
                });
            }
        }
    }

    /**
     * Get GitHub username using authentication
     * @returns Promise resolving to GitHub username or undefined
     */
    private async getAuthenticatedGitHubUsername(): Promise<string | undefined> {
        try {
            // GitHub Authentication namespace
            const GITHUB_AUTH_PROVIDER_ID = 'github';
            // The GitHub Authentication session scopes
            const SCOPES = ['user:email', 'read:user'];
            
            // Check if VS Code has the GitHub Authentication API available
            const authenticationApi = vscode.authentication;
            
            if (!authenticationApi) {
                vscode.window.showErrorMessage('GitHub authentication is not available');
                return undefined;
            }
            
            // Get GitHub authentication session
            const session = await vscode.authentication.getSession(
                GITHUB_AUTH_PROVIDER_ID,
                SCOPES,
                { createIfNone: true }
            );
            
            if (session) {
                // Use GitHub API to get user information
                const accessToken = session.accessToken;
                
                // Call GitHub API
                const response = await fetch('https://api.github.com/user', {
                    headers: {
                        'Authorization': 'token ' + accessToken,
                        'User-Agent': 'YNA-VSCode-Extension'
                    }
                });
                
                if (response.ok) {
                    const userData = await response.json();
                    return userData.login; // GitHub username
                } else {
                    vscode.window.showErrorMessage('Failed to get GitHub user information');
                    return undefined;
                }
            } else {
                vscode.window.showErrorMessage('GitHub authentication failed');
                return undefined;
            }
        } catch (error) {
            console.error('Failed to authenticate with GitHub:', error);
            vscode.window.showErrorMessage(`GitHub authentication error: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    // Update the online users count in the webview
    private updateOnlineUsersCount() {
        if (this._view && this.webviewReady) {
            this._view.webview.postMessage({
                command: 'updateOnlineUsers',
                count: this.onlineUsersCount
            });
        }
    }

    /**
     * Check if this webview is currently visible to the user
     * @returns boolean indicating whether the view is visible
     */
    public isVisible(): boolean {
        return this._view !== undefined && this._view.visible === true;
    }

    /**
     * Reset the new check-ins counter
     */
    public resetNewCheckInsCount(): void {
        this.newCheckInsCount = 0;
    }
    
    /**
     * Get the count of new check-ins since the panel was last visible
     */
    public getNewCheckInsCount(): number {
        return this.newCheckInsCount;
    }
    
    /**
     * Get the total number of check-ins
     */
    public getCheckInsCount(): number {
        return this.checkIns.length;
    }

    private updateCooldownStatus(remainingMs: number) {
        if (this._view && this.webviewReady) {
            this._view.webview.postMessage({
                command: 'updateCooldown',
                remainingMs: remainingMs,
                formattedTime: this.webSocketClient.getFormattedCooldownTime()
            });
        }
    }

    /**
     * Check authentication status and reconnect WebSocket if needed
     * This is called when the view is resolved to ensure we're properly connected
     */
    private async checkAuthAndReconnect() {
        try {
            const username = await this.getAuthenticatedGitHubUsername();
            
            if (username) {
                // Only reconnect if not already connected
                if (!this.webSocketClient.isConnected()) {
                    console.log('Reconnecting WebSocket for authenticated user...');
                    // Ensure WebSocket is connected
                    this.webSocketClient.reconnect();
                    
                    // Wait a short moment for the connection to attempt to establish
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                    // If still not connected, show a message
                    if (!this.webSocketClient.isConnected()) {
                        console.log('WebSocket reconnection in progress...');
                        if (this._view && this.webviewReady) {
                            this._view.webview.postMessage({
                                command: 'connectionStatus',
                                connected: false,
                                message: 'Reconnecting to server...'
                            });
                        }
                    } else {
                        console.log('WebSocket reconnection successful');
                    }
                } else {
                    console.log('WebSocket already connected');
                }
            } else {
                console.log('User not authenticated, skipping WebSocket reconnection');
            }
        } catch (error) {
            console.error('Error in checkAuthAndReconnect:', error);
        }
    }

    /**
     * Handle login request from webview
     */
    private async handleLogin() {
        try {
            // Attempt to get authenticated username
            const username = await this.getAuthenticatedGitHubUsername();
            
            if (username) {
                // Try to reconnect if needed
                if (!this.webSocketClient.isConnected()) {
                    this.webSocketClient.reconnect();
                    
                    // Wait a moment for connection to establish
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
                
                // Update UI
                await this.checkAuthAndUpdateUI();
            } else {
                // Handle case where login fails
                if (this._view && this.webviewReady) {
                    this._view.webview.postMessage({
                        command: 'updateAuthState',
                        isAuthenticated: false
                    });
                }
            }
        } catch (error) {
            console.error('Error handling login:', error);
            // Show error message to user
            if (this._view && this.webviewReady) {
                this._view.webview.postMessage({
                    command: 'showError',
                    message: 'Login failed. Please try again.'
                });
            }
        }
    }

    /**
     * Check authentication status and update the UI accordingly
     */
    private async checkAuthAndUpdateUI() {
        const username = await this.getAuthenticatedGitHubUsername();
        const isAuthenticated = !!username;
        
        // Check if we have a webview to update
        if (!this._view || !this.webviewReady) {
            // console.log('Cannot update auth UI: Webview not ready');
            return;
        }
        
        // Update the authentication state in the webview
        this._view.webview.postMessage({
            command: 'updateAuthState',
            isAuthenticated,
            username
        });
        
        // If authenticated, ensure connection is established
        if (isAuthenticated) {
            this.checkAuthAndReconnect();
        }
    }

    /**
     * Update the UI based on current authentication status
     * Public method that can be called from extension.ts
     */
    public updateAuthState(): void {
        this.checkAuthAndUpdateUI();
    }
}