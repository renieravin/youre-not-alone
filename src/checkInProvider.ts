import * as vscode from 'vscode';
import { WebSocketClient, NewCheckInMessage } from './webSocketClient';

export interface CheckInData {
    username: string;
    tags: string[];
    message: string;
    timestamp: string;
    avatarUrl?: string; // Optional GitHub avatar URL
}

export class CheckInProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
    
    private checkIns: CheckInData[] = [];
    private maxCheckIns = 100; // Maximum number of check-ins to store
    private isLoading = true;
    
    constructor(private webSocketClient: WebSocketClient) {
        // Show loading state initially
        this.isLoading = true;
        
        // Listen for new check-ins
        this.webSocketClient.onMessageReceived(message => {
            this.addCheckIn({
                username: message.username,
                tags: message.tags,
                message: message.message,
                timestamp: message.timestamp,
                avatarUrl: message.avatarUrl
            });
        });
        
        // Listen for initial history received event
        this.webSocketClient.onHistoryReceived(() => {
            this.isLoading = false;
            // Refresh the view after history is loaded
            this._onDidChangeTreeData.fire(undefined);
        });
        
        // Listen for connection status changes
        this.webSocketClient.onConnectionStatusChanged(connected => {
            if (connected) {
                // When reconnected, only update the loading state if we don't have check-ins yet
                if (this.checkIns.length === 0) {
                    this.isLoading = true;
                    this._onDidChangeTreeData.fire(undefined);
                }
            }
        });
    }
    
    private addCheckIn(checkIn: CheckInData) {
        // Check if this check-in already exists (by username and timestamp)
        const existingIndex = this.checkIns.findIndex(
            c => c.username === checkIn.username && c.timestamp === checkIn.timestamp
        );
        
        if (existingIndex !== -1) {
            // Update existing check-in
            this.checkIns[existingIndex] = checkIn;
        } else {
            // Add the new check-in at the beginning of the array
            this.checkIns.unshift(checkIn);
            
            // Limit the number of check-ins stored
            if (this.checkIns.length > this.maxCheckIns) {
                this.checkIns = this.checkIns.slice(0, this.maxCheckIns);
            }
        }
        
        // Notify that the tree data has changed - pass undefined to refresh entire tree
        this._onDidChangeTreeData.fire(undefined);
        
        // Show a notification for debugging - but only for new check-ins
        if (existingIndex === -1) {
            if (!checkIn.message) {
                vscode.window.showInformationMessage(`${checkIn.username} checked in`);
            } else {
                vscode.window.showInformationMessage(`${checkIn.username} checked in: ${checkIn.message}`);
            }
        }
    }
    
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
        return element;
    }
    
    getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
        // We're only showing a flat list, no tree hierarchy
        if (element) {
            return [];
        }
        
        // If loading and we haven't received any check-ins yet, show a loading message
        if (this.isLoading) {
            return [new vscode.TreeItem('Loading check-ins...')];
        }
        
        // Return all check-ins as a flat list
        if (this.checkIns.length === 0) {
            // Provide a placeholder message when there are no check-ins
            return [new vscode.TreeItem('No check-ins yet. Use "You\'re Not Alone: Check In" to add one.')];
        }
        
        return this.checkIns.map(checkIn => new CheckInItem(checkIn));
    }
}

export class CheckInItem extends vscode.TreeItem {
    constructor(private checkIn: CheckInData) {
        // Format timestamp for display
        const timestamp = new Date(checkIn.timestamp);
        const timeString = timestamp.toLocaleTimeString();
        
        // Create a display name with username and time
        super(
            `${checkIn.username}`,
            vscode.TreeItemCollapsibleState.None // Never collapsible
        );
        
        // Show timestamp in description
        this.description = `${timeString}`;
        
        // Create tooltip with all information
        this.tooltip = `${checkIn.username} checked in at ${timestamp.toLocaleString()}`;
        
        // Create a label with formatting
        if (checkIn.tags.length > 0) {
            this.tooltip += `\nWorking on: ${checkIn.tags.join(', ')}`;
        }
        
        if (checkIn.message) {
            this.tooltip += `\nMessage: ${checkIn.message}`;
        }
        
        // Create a custom label to show more information inline
        this.label = {
            label: checkIn.username,
            highlights: [[0, checkIn.username.length]]
        };
        
        // Create custom markdown content for the check-in item
        const tagsDisplay = checkIn.tags.length > 0 
            ? `Working on ${checkIn.tags.join(', ')}` 
            : '';
        
        const messageDisplay = checkIn.message 
            ? `\n${checkIn.message}` 
            : '';
        
        // Set contextValue to enable context menu items specific to check-ins
        this.contextValue = 'checkIn';
        
        // Use GitHub avatar if available, otherwise use language icon or default icon
        if (checkIn.avatarUrl) {
            // Use GitHub avatar with a larger custom rendering
            // We'll use a custom URI to trigger our own content provider
            const largeAvatarUrl = checkIn.avatarUrl.replace('.png', '?size=150');
            this.iconPath = vscode.Uri.parse(largeAvatarUrl);
            
            // Add a custom class to enable styling (doesn't affect VS Code's built-in tree view directly,
            // but can be used if we move to a custom webview implementation later)
            this.command = {
                title: 'View Profile',
                command: 'yna.viewProfile',
                arguments: [checkIn.username]
            };
        } else if (checkIn.tags.length > 0) {
            // Try to determine icon for the first language tag
            const languageTag = checkIn.tags[0].toLowerCase();
            
            // Map common languages to icons
            // These are stock VSCode icons - could be customized with more specific ones
            const iconMap: Record<string, { light: string, dark: string }> = {
                'javascript': { light: 'javascript', dark: 'javascript' },
                'typescript': { light: 'typescript', dark: 'typescript' },
                'python': { light: 'python', dark: 'python' },
                'java': { light: 'java', dark: 'java' },
                'html': { light: 'html', dark: 'html' },
                'css': { light: 'css', dark: 'css' },
                'php': { light: 'php', dark: 'php' },
                'csharp': { light: 'csharp', dark: 'csharp' },
                'go': { light: 'go', dark: 'go' }
            };
            
            // Assign icon if we have one for this language
            if (iconMap[languageTag]) {
                this.iconPath = new vscode.ThemeIcon(iconMap[languageTag].dark);
            } else {
                this.iconPath = new vscode.ThemeIcon('person');
            }
        } else {
            this.iconPath = new vscode.ThemeIcon('person');
        }
        
        // Create a description that includes both tags and message
        if (checkIn.message) {
            this.description = tagsDisplay ? `${tagsDisplay} - ${checkIn.message}` : checkIn.message;
        } else {
            this.description = tagsDisplay;
        }
        
        // Create custom tooltip with all information
        this.tooltip = new vscode.MarkdownString(
            `**${checkIn.username}** checked in at ${timestamp.toLocaleString()}\n` +
            (tagsDisplay ? `\n${tagsDisplay}` : '') +
            (messageDisplay ? `\n\n${messageDisplay}` : '')
        );
    }
} 