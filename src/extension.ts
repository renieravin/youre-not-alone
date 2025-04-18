import * as vscode from 'vscode';
import { WebSocketClient } from './webSocketClient';
import fetch from 'node-fetch';
import { SecondaryCheckInView } from './secondaryCheckInView';
import { FileHistoryTracker } from './fileHistoryTracker';
import { getActiveFileTags } from './tagsUtils';

// GitHub Authentication namespace
const GITHUB_AUTH_PROVIDER_ID = 'github';
// The GitHub Authentication session scopes
const SCOPES = ['user:email', 'read:user'];

// GitHub API user response interface
interface GitHubUser {
    login: string;
    id: number;
    name?: string;
    email?: string;
}

export async function activate(context: vscode.ExtensionContext) {
    // Create our WebSocket client with the deployed Cloudflare Worker URL
    // Don't auto-connect - we'll connect after checking authentication
    const webSocketClient = new WebSocketClient('wss://yna-backend.renie-ravin.workers.dev', context.extensionUri, false);
    
    // Get the file history tracker instance
    const fileTracker = FileHistoryTracker.getInstance();
    
    // Create permanent status bar item for connection status and stats
    const statusBarPermanent = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    statusBarPermanent.command = 'yna.openCheckInView';
    statusBarPermanent.text = '$(heart) You\'re not alone: checking login...';
    statusBarPermanent.tooltip = 'Click to view check-ins';
    statusBarPermanent.show();
    context.subscriptions.push(statusBarPermanent);
    
    // Check if the user is authenticated and connect if they are
    try {
        const username = await getAuthenticatedGitHubUsername(context);
        if (username) {
            webSocketClient.reconnect();
            statusBarPermanent.text = '$(heart) You\'re not alone: connecting...';
        } else {
            statusBarPermanent.text = '$(heart) You\'re not alone: sign in to connect';
        }
    } catch (error) {
        console.error('Error checking authentication:', error);
        statusBarPermanent.text = '$(heart) You\'re not alone: authentication error';
    }
    
    // Track temporary message state
    let temporaryMessageActive = false;
    let temporaryMessageTimeout: NodeJS.Timeout | null = null;
    
    // Function to temporarily display a confirmation message in the status bar
    function showTemporaryStatusMessage(message: string, durationMs: number = 3000) {
        // Clear any existing timeout
        if (temporaryMessageTimeout) {
            clearTimeout(temporaryMessageTimeout);
            temporaryMessageTimeout = null;
        }
        
        // Store the current stats message if not already in temporary message mode
        const originalText = statusBarPermanent.text;
        
        // Set flag to indicate we're showing a temporary message
        temporaryMessageActive = true;
        
        // Update with temporary message, keeping the heart icon
        statusBarPermanent.text = `$(heart) ${message}`;
        
        // Set timeout to restore the original message
        temporaryMessageTimeout = setTimeout(() => {
            // Reset the flag
            temporaryMessageActive = false;
            temporaryMessageTimeout = null;
            
            // Restore original text
            statusBarPermanent.text = originalText;
            
            // Request updated stats
            webSocketClient.requestOnlineUsers();
        }, durationMs);
    }
    
    // Create status bar item for notifications
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'yna.openCheckInView';
    context.subscriptions.push(statusBarItem);
    
    // Simple debounce function to prevent too many file tracking events
    let debounceTimer: NodeJS.Timeout | null = null;
    const addFileWithDebounce = (fileName: string) => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            fileTracker.addFile(fileName);
            debounceTimer = null;
        }, 300); // 300ms debounce
    };
    
    // Register text document event listeners to track file edits
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            const document = event.document;
            if (document.uri.scheme === 'file') {
                addFileWithDebounce(document.fileName);
            }
        })
    );
    
    // Also track when editors are switched/focused
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && editor.document && editor.document.uri.scheme === 'file') {
                addFileWithDebounce(editor.document.fileName);
            }
        })
    );
    
    // Track files when they're initially opened
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(document => {
            if (document.uri.scheme === 'file') {
                addFileWithDebounce(document.fileName);
            }
        })
    );
    
    // Register the webview provider in the primary sidebar
    const checkInViewProvider = new SecondaryCheckInView(context.extensionUri, webSocketClient, context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SecondaryCheckInView.viewType,
            checkInViewProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
    );
    
    // Handle WebSocket connection status changes
    webSocketClient.onConnectionStatusChanged(connected => {
        if (temporaryMessageActive) {
            // Skip updating if a temporary message is active
            return;
        }
        
        if (connected) {
            statusBarPermanent.text = '$(heart) Loading stats...';
            // When connected, request the latest stats
            webSocketClient.requestOnlineUsers();
        } else {
            statusBarPermanent.text = '$(heart) You\'re not alone: disconnected';
        }
    });
    
    // Update stats when online users count changes
    webSocketClient.onOnlineUsersChanged(count => {
        if (temporaryMessageActive) {
            // Skip updating if a temporary message is active
            return;
        }
        
        if (webSocketClient.isConnected()) {
            const checkInsCount = checkInViewProvider.getCheckInsCount();
            statusBarPermanent.text = `$(heart) ${count} fellow dev${count === 1 ? '' : 's'} online • ${checkInsCount} check-in${checkInsCount === 1 ? '' : 's'}`;
        }
    });
    
    // Update stats when check-ins count changes
    checkInViewProvider.onCheckInsCountChanged((count: number) => {
        if (temporaryMessageActive) {
            // Skip updating if a temporary message is active
            return;
        }
        
        if (webSocketClient.isConnected()) {
            const onlineCount = webSocketClient.getOnlineUsersCount();
            statusBarPermanent.text = `$(heart) ${onlineCount} fellow dev${onlineCount === 1 ? '' : 's'} online • ${count} check-in${count === 1 ? '' : 's'}`;
        }
    });
    
    // Listen for view visibility changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            setTimeout(() => {
                // Add a small delay to let visibility state update
                if (checkInViewProvider.isVisible()) {
                    statusBarItem.hide();
                    checkInViewProvider.resetNewCheckInsCount();
                }
            }, 100);
        })
    );
    
    // Also monitor for sidebar panel changes
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState(() => {
            if (checkInViewProvider.isVisible()) {
                statusBarItem.hide();
                checkInViewProvider.resetNewCheckInsCount();
            }
        })
    );
    
    // Register commands for notification management
    const notifyNewCheckInCommand = vscode.commands.registerCommand('yna.notifyNewCheckIn', () => {
        if (!checkInViewProvider.isVisible()) {
            const newCount = checkInViewProvider.getNewCheckInsCount();
            if (newCount > 0) {
                statusBarItem.text = `$(bell) ${newCount} new check-in${newCount === 1 ? '' : 's'}`;
                statusBarItem.tooltip = 'Click to open Check-In panel';
                statusBarItem.show();
            }
        }
    });
    
    const hideStatusBarNotificationCommand = vscode.commands.registerCommand('yna.hideStatusBarNotification', () => {
        statusBarItem.hide();
    });
    
    const showTemporaryMessageCommand = vscode.commands.registerCommand('yna.showTemporaryMessage', (message: string) => {
        showTemporaryStatusMessage(message);
    });
    
    const openCheckInViewCommand = vscode.commands.registerCommand('yna.openCheckInView', () => {
        vscode.commands.executeCommand('workbench.view.extension.yna-sidebar');
        vscode.commands.executeCommand(`${SecondaryCheckInView.viewType}.focus`);
        // Reset the counter when the status bar is clicked
        checkInViewProvider.resetNewCheckInsCount();
        statusBarItem.hide();
    });
    
    // Register commands
    const checkInCommand = vscode.commands.registerCommand('yna.checkIn', async () => {
        // Try to get GitHub username using authentication
        let username = await getAuthenticatedGitHubUsername(context);
        
        if (!username) {
            vscode.window.showErrorMessage('GitHub authentication is required to check in');
            return;
        }
        
        // Ensure WebSocket is connected
        if (!webSocketClient.isConnected()) {
            webSocketClient.reconnect();
            
            // Wait a moment for the connection to establish
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Verify connection
            if (!webSocketClient.isConnected()) {
                vscode.window.showErrorMessage('Could not connect to YNA server. Please try again later.');
                return;
            }
        }
        
        // Check if user is on cooldown
        if (!webSocketClient.canCheckIn()) {
            const cooldownTime = webSocketClient.getFormattedCooldownTime();
            vscode.window.showInformationMessage(`You can check in again in ${cooldownTime}.`);
            return;
        }
        
        // Automatically get the active file's language as tags
        const activeLanguageTags = getActiveFileTags();
        
        // Define the character limit
        const MAX_CHARS = 42;
        
        // Prompt for a message
        const messageInput = await vscode.window.showInputBox({
            prompt: `Enter a message (optional, max ${MAX_CHARS} characters)`,
            placeHolder: "What's on your mind?",
            validateInput: (text) => {
                if (text.length > MAX_CHARS) {
                    return `Message must be ${MAX_CHARS} characters or less (currently ${text.length})`;
                }
                return null; // Input is valid
            }
        });
        
        // Return if cancelled or if message exceeds limit
        if (messageInput === undefined) {
            return;
        }
        
        if (messageInput.length > MAX_CHARS) {
            vscode.window.showErrorMessage(`Message exceeds limit of ${MAX_CHARS} characters`);
            return;
        }
        
        // Use detected tags automatically
        const tags = activeLanguageTags;
        
        // Send check-in to server (WebSocketClient will handle the snippet)
        const success = await webSocketClient.sendCheckIn(username, tags, messageInput || '');
        
        // Show temporary confirmation in the status bar
        if (success) {
            if (tags.length > 0) {
                showTemporaryStatusMessage(`Checked in as ${username} working on ${tags.join(', ')}`);
            } else {
                showTemporaryStatusMessage(`Checked in as ${username}`);
            }
        } else {
            vscode.window.showErrorMessage('Check-in failed. Please try again later.');
        }
    });
    
    // Register the viewProfile command
    const viewProfileCommand = vscode.commands.registerCommand('yna.viewProfile', (username: string) => {
        // Open the user's GitHub profile in a browser
        vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${username}`));
    });

    // Register the logout command
    const logoutCommand = vscode.commands.registerCommand('yna.logout', async () => {
        try {
            // Disconnect from WebSocket
            webSocketClient.dispose();
            
            // Sign out by clearing the session - using the proper VS Code API
            const session = await vscode.authentication.getSession(
                GITHUB_AUTH_PROVIDER_ID,
                SCOPES,
                { createIfNone: false, clearSessionPreference: true }
            );
            
            if (session) {
                // The next time authentication is needed, it will prompt the user again
                vscode.window.showInformationMessage('Successfully logged out from You\'re Not Alone');
            } else {
                vscode.window.showInformationMessage('No active session to log out from');
            }
            
            // Signal auth status change to update any open webviews
            setTimeout(() => {
                vscode.commands.executeCommand('yna.authChanged', false);
            }, 500);
        } catch (error) {
            console.error('Error logging out:', error);
            vscode.window.showErrorMessage('Failed to log out: ' + (error instanceof Error ? error.message : 'Unknown error'));
        }
    });

    // Register a command to handle authentication status changes
    const authChangedCommand = vscode.commands.registerCommand('yna.authChanged', async (isAuthenticated: boolean) => {
        webSocketClient.updateAuthStatus(isAuthenticated);
        
        // Directly notify the secondary view of the auth change
        checkInViewProvider.updateAuthState();
    });

    // Open the primary sidebar
    vscode.commands.executeCommand('workbench.view.extension.yna-sidebar');

    // Add disposables to context
    context.subscriptions.push(
        checkInCommand, 
        viewProfileCommand,
        logoutCommand,
        notifyNewCheckInCommand,
        hideStatusBarNotificationCommand,
        showTemporaryMessageCommand,
        openCheckInViewCommand,
        authChangedCommand
    );
}

export function deactivate() {
    // Clean up resources when extension is deactivated
}

/**
 * Get GitHub username using authentication
 * @returns Promise resolving to GitHub username or undefined
 */
export async function getAuthenticatedGitHubUsername(context?: vscode.ExtensionContext): Promise<string | undefined> {
    try {
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
            const userResponse = await fetch('https://api.github.com/user', {
                headers: {
                    'Authorization': `token ${accessToken}`,
                    'User-Agent': 'YNA-VSCode-Extension'
                }
            });
            
            if (userResponse.ok) {
                const userData = await userResponse.json() as GitHubUser;
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