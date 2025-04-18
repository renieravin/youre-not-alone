import WebSocket from 'ws';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import config from '../../config.json';

// Define the message types
export interface CheckInMessage {
    type: 'checkin';
    username: string;
    tags: string[];
    message: string;
    timestamp: string;
    avatarUrl?: string; // Optional GitHub avatar URL
    snippet?: string; // Random code snippet when a language is detected
    token?: string; // GitHub authentication token (only in request, never stored)
    signature?: string; // HMAC signature for message verification
    signatureTimestamp?: string; // Timestamp used in generating the signature
}

export interface NewCheckInMessage {
    type: 'new_checkin';
    username: string;
    tags: string[];
    message: string;
    timestamp: string;
    avatarUrl?: string; // Optional GitHub avatar URL
    snippet?: string; // Random code snippet when a language is detected
}

export interface OnlineUsersMessage {
    type: 'online_users';
    count: number;
}

export interface ErrorMessage {
    type: 'error';
    message: string;
}

export type Message = CheckInMessage | NewCheckInMessage | OnlineUsersMessage | ErrorMessage;

export class WebSocketClient {
    private socket: WebSocket | null = null;
    private reconnectInterval = 5000; // 5 seconds
    private url: string;
    private _onMessageReceived = new vscode.EventEmitter<NewCheckInMessage>();
    private _onConnectionStatusChanged = new vscode.EventEmitter<boolean>();
    private _onHistoryReceived = new vscode.EventEmitter<void>();
    private _onOnlineUsersChanged = new vscode.EventEmitter<number>();
    private _onCooldownChanged = new vscode.EventEmitter<number>(); // Add cooldown event emitter
    private initialHistoryReceived = false;
    private allReceivedCheckIns: NewCheckInMessage[] = []; // Store all received check-ins
    private receivingInitialHistory = false;
    private lastHistoryMessageTime = 0;
    private onlineUsersCount = 0;
    private extensionUri: vscode.Uri; // Store the extension URI for file access
    private snippets: string[] = []; // Cache the snippets
    private snippetsLoaded = false;
    private lastCheckInTime = 0; // Track when user last checked in
    private cooldownPeriodMs = 10 * 60 * 1000; // 10 minutes in milliseconds
    private isAuthenticated = true; // Add authentication status
    private autoReconnect = true; // Add auto-reconnect flag

    // Event that fires when a new check-in message is received
    public readonly onMessageReceived = this._onMessageReceived.event;
    // Event that fires when connection status changes
    public readonly onConnectionStatusChanged = this._onConnectionStatusChanged.event;
    // Event that fires when initial history is received
    public readonly onHistoryReceived = this._onHistoryReceived.event;
    // Event that fires when online users count changes
    public readonly onOnlineUsersChanged = this._onOnlineUsersChanged.event;
    // Event that fires when cooldown status changes
    public readonly onCooldownChanged = this._onCooldownChanged.event;
    
    constructor(url: string, extensionUri: vscode.Uri, autoConnect: boolean = false) {
        this.url = url;
        this.extensionUri = extensionUri;
        
        // Use cooldown period from config instead of hardcoded value
        this.cooldownPeriodMs = config.cooldownPeriod.minutes * 60 * 1000;
        
        // Preload the snippets
        this.loadSnippets();
        
        if (autoConnect) {
            // Attempt to connect to the real WebSocket server
            this.connect();
            
            // As a fallback, if connection fails, we'll still show some data
            setTimeout(() => {
                if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
                    this.simulateData();
                }
            }, 5000);
        }
    }
    
    // Load snippets from fml.json
    private async loadSnippets() {
        try {
            const fmlPath = vscode.Uri.joinPath(this.extensionUri, 'data', 'fml.json');
            const data = await vscode.workspace.fs.readFile(fmlPath);
            this.snippets = JSON.parse(data.toString());
            this.snippetsLoaded = true;
        } catch (error) {
            console.error(`Error loading snippets: ${error instanceof Error ? error.message : String(error)}`);
            // Use some default snippets as fallback
            this.snippets = [
                "🚀 is coding with enthusiasm",
                "💻 is deep in thought with",
                "🔥 is on fire working on",
                "🎯 is focused on building",
                "⚡ is supercharging their workflow with"
            ];
            this.snippetsLoaded = true;
        }
    }
    
    // Get a random snippet
    private getRandomSnippet(): string {
        if (!this.snippetsLoaded || this.snippets.length === 0) {
            return "🔍 is working on something mysterious";
        }
        return this.snippets[Math.floor(Math.random() * this.snippets.length)];
    }
    
    private connect() {
        // If already connecting or connected, don't try again
        if (this.socket) {
            if (this.socket.readyState === WebSocket.CONNECTING) {
                console.log('Already attempting to connect, skipping duplicate attempt');
                return;
            }
            if (this.socket.readyState === WebSocket.OPEN) {
                console.log('WebSocket already connected');
                this._onConnectionStatusChanged.fire(true);
                return;
            }
            
            // Close existing socket if not already closed
            if (this.socket.readyState !== WebSocket.CLOSED) {
                try {
                    this.socket.removeAllListeners();
                    this.socket.close();
                } catch (err) {
                    console.error('Error closing existing socket:', err);
                }
            }
            this.socket = null;
        }
        
        // Reset the history received flag when we reconnect
        this.initialHistoryReceived = false;
        this.receivingInitialHistory = true;
        
        console.log('Initiating new WebSocket connection...');
        
        try {
            // Get auth token before connecting
            this.getAuthToken().then(token => {
                try {
                    // Add token to URL if available
                    const connectionUrl = token 
                        ? `${this.url}?token=${encodeURIComponent(token)}` 
                        : this.url;
                    
                    console.log('Creating new WebSocket connection...');
                    
                    // Create a new WebSocket
                    this.socket = new WebSocket(connectionUrl);
                    
                    // Track connection timeout
                    const connectionTimeoutId = setTimeout(() => {
                        if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
                            console.log('WebSocket connection timed out');
                            this.socket.close();
                            this._onConnectionStatusChanged.fire(false);
                        }
                    }, 10000); // 10 second timeout
                    
                    // Set up event handlers immediately before any operations
                    this.socket.on('error', (error) => {
                        console.error('WebSocket error:', error);
                        this._onConnectionStatusChanged.fire(false);
                    });
                    
                    this.socket.on('close', (code, reason) => {
                        console.log(`WebSocket closed with code ${code}${reason ? ': ' + reason : ''}`);
                        this._onConnectionStatusChanged.fire(false);
                        
                        // Check if this was an authentication error
                        if (code === 4000 || reason?.includes('auth')) {
                            vscode.window.showErrorMessage('Authentication failed. Please sign in to continue.');
                        } else if (this.autoReconnect) {
                            // Try to reconnect after a delay, with increasing backoff
                            console.log(`Will attempt reconnect in ${this.reconnectInterval/1000} seconds`);
                            setTimeout(() => {
                                // Increase reconnect interval for exponential backoff (max 30 seconds)
                                this.reconnectInterval = Math.min(this.reconnectInterval * 1.5, 30000);
                                this.connect();
                            }, this.reconnectInterval);
                        }
                    });
                    
                    this.socket.on('open', () => {
                        console.log('WebSocket connection established successfully');
                        // Clear timeout when connection succeeds
                        clearTimeout(connectionTimeoutId);
                        // Reset reconnect interval on successful connection
                        this.reconnectInterval = 5000;
                        this._onConnectionStatusChanged.fire(true);
                        this.lastHistoryMessageTime = Date.now();
                    });
                    
                    // Track if we've received messages to detect the first batch
                    let messageCount = 0;
                    let historyTimeout: NodeJS.Timeout | null = null;
                    
                    this.socket.on('message', (data: WebSocket.Data) => {
                        try {
                            const message = JSON.parse(data.toString()) as Message;
                            
                            if (message.type === 'new_checkin') {
                                messageCount++;
                                const now = Date.now();
                                this.lastHistoryMessageTime = now;
                                
                                // Store in our full history
                                this.storeCheckIn(message);
                                
                                // When receiving history, we expect messages to come quickly
                                // If there's a significant gap, we assume history is complete
                                if (this.receivingInitialHistory) {
                                    // Reset timeout with each message
                                    if (historyTimeout) {
                                        clearTimeout(historyTimeout);
                                        historyTimeout = null;
                                    }
                                    
                                    // Set a timeout to consider history complete if no more messages arrive
                                    historyTimeout = setTimeout(() => {
                                        if (this.receivingInitialHistory && !this.initialHistoryReceived) {
                                            this.receivingInitialHistory = false;
                                            this.initialHistoryReceived = true;
                                            this._onHistoryReceived.fire();
                                        }
                                    }, 1000); // Wait 1 second after last message
                                }
                                
                                // Emit the message event
                                this._onMessageReceived.fire(message);
                            } else if (message.type === 'online_users') {
                                // Handle online users count update
                                this.onlineUsersCount = message.count;
                                this._onOnlineUsersChanged.fire(this.onlineUsersCount);
                            } else if (message.type === 'error') {
                                // Handle error messages from server
                                console.error(`Server error: ${message.message}`);
                                vscode.window.showErrorMessage(`Server error: ${message.message}`);
                            }
                        } catch (error) {
                            console.error('Error parsing WebSocket message:', error);
                        }
                    });
                    
                    // Set a timeout to handle the case where no messages are received
                    setTimeout(() => {
                        if (this.receivingInitialHistory && !this.initialHistoryReceived) {
                            this.receivingInitialHistory = false;
                            this.initialHistoryReceived = true;
                            this._onHistoryReceived.fire();
                        }
                    }, 3000); // Wait 3 seconds after connection to trigger empty history
                } catch (error) {
                    console.error('Error creating WebSocket connection:', error);
                    this._onConnectionStatusChanged.fire(false);
                    
                    // Try to reconnect after a delay if auto-reconnect is enabled
                    if (this.autoReconnect) {
                        setTimeout(() => this.connect(), this.reconnectInterval);
                    }
                }
            }).catch(error => {
                console.error('Error getting auth token:', error);
                this._onConnectionStatusChanged.fire(false);
                
                // Try to reconnect after a delay if auto-reconnect is enabled
                if (this.autoReconnect) {
                    setTimeout(() => this.connect(), this.reconnectInterval);
                }
            });
        } catch (error) {
            console.error('Error connecting to WebSocket:', error);
            this._onConnectionStatusChanged.fire(false);
            
            // Try to reconnect after a delay if auto-reconnect is enabled
            if (this.autoReconnect) {
                setTimeout(() => this.connect(), this.reconnectInterval);
            }
        }
    }
    
    /**
     * Get the GitHub authentication token
     * @returns Promise resolving to token or undefined
     */
    private async getAuthToken(): Promise<string | undefined> {
        try {
            // GitHub Authentication namespace
            const GITHUB_AUTH_PROVIDER_ID = 'github';
            // The GitHub Authentication session scopes
            const SCOPES = ['user:email', 'read:user'];
            
            // Get GitHub authentication session without forcing creation
            const session = await vscode.authentication.getSession(
                GITHUB_AUTH_PROVIDER_ID,
                SCOPES,
                { createIfNone: false }
            );
            
            if (session) {
                return session.accessToken;
            }
            return undefined;
        } catch (error) {
            console.error('Failed to get GitHub authentication token:', error);
            return undefined;
        }
    }
    
    // Store check-in with unique username, keeping only the latest for each user
    private storeCheckIn(checkIn: NewCheckInMessage) {
        try {
            // Check if this user already has a check-in
            const existingIndex = this.allReceivedCheckIns.findIndex(c => c.username === checkIn.username);
    
            if (existingIndex !== -1) {
                const existingTimestamp = new Date(this.allReceivedCheckIns[existingIndex].timestamp).getTime();
                const newTimestamp = new Date(checkIn.timestamp).getTime();
                
                // Only update if the new check-in is newer than the existing one
                if (newTimestamp > existingTimestamp) {
                    this.allReceivedCheckIns[existingIndex] = checkIn;
                }
            } else {
                // Add new check-in
                this.allReceivedCheckIns.push(checkIn);
            }
        } catch (error) {
            console.error("Error storing check-in:", error);
        }
    }
    
    // Return all check-ins we've received
    public getAllCheckIns(): NewCheckInMessage[] {
        return [...this.allReceivedCheckIns];
    }
    
    // Return the current online users count
    public getOnlineUsersCount(): number {
        return this.onlineUsersCount;
    }
    
    /**
     * Check if the WebSocket connection is currently open
     * @returns true if connected, false otherwise
     */
    public isConnected(): boolean {
        return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
    }
    
    // Request online users count from the server
    public requestOnlineUsers() {
        if (this.socket?.readyState === WebSocket.OPEN) {
            // Send a online users request message to the server
            const onlineUsersRequest = {
                type: 'online_users_request'
            };
            this.socket.send(JSON.stringify(onlineUsersRequest));
        }
    }
    
    // Request history from the server
    public requestHistory() {
        // Reset the history received flag
        this.initialHistoryReceived = false;
        this.receivingInitialHistory = true;
        
        if (this.socket?.readyState === WebSocket.OPEN) {
            // Send a history request message to the server
            const historyRequest = {
                type: 'history_request'
            };
            this.socket.send(JSON.stringify(historyRequest));
            
            // Set a timeout to handle the case where no response is received
            setTimeout(() => {
                if (this.receivingInitialHistory && !this.initialHistoryReceived) {
                    this.receivingInitialHistory = false;
                    this.initialHistoryReceived = true;
                    this._onHistoryReceived.fire();
                }
            }, 3000); // Wait 3 seconds for response
        } else {
            // Fire history event with existing data if we have any
            this.initialHistoryReceived = true;
            this._onHistoryReceived.fire();
        }
    }
    
    /**
     * Check if the user is allowed to check in
     * @returns boolean indicating if cooldown period has passed
     */
    public canCheckIn(): boolean {
        const now = Date.now();
        return now - this.lastCheckInTime >= this.cooldownPeriodMs;
    }

    /**
     * Get remaining cooldown time in milliseconds
     * @returns number of milliseconds until next check-in is allowed, or 0 if can check in now
     */
    public getRemainingCooldownTime(): number {
        const now = Date.now();
        const elapsed = now - this.lastCheckInTime;
        
        if (elapsed >= this.cooldownPeriodMs) {
            return 0;
        }
        
        return this.cooldownPeriodMs - elapsed;
    }

    /**
     * Format remaining cooldown time as a string (MM:SS)
     * @returns formatted string showing remaining cooldown time
     */
    public getFormattedCooldownTime(): string {
        const remainingMs = this.getRemainingCooldownTime();
        
        if (remainingMs <= 0) {
            return "Available now";
        }
        
        // Convert to minutes and seconds
        const totalSeconds = Math.ceil(remainingMs / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        
        // Format as MM:SS
        return `${minutes}m ${seconds}s`;
    }

    /**
     * Start a timer to update cooldown state
     * Emits events as the cooldown progresses
     */
    private startCooldownTimer() {
        // Don't start if we're already available
        if (this.getRemainingCooldownTime() <= 0) {
            return;
        }
        
        // Fire initial event with current state
        this._onCooldownChanged.fire(this.getRemainingCooldownTime());
        
        // Set up an interval to update every second
        const timer = setInterval(() => {
            const remaining = this.getRemainingCooldownTime();
            
            // Fire the event with updated time
            this._onCooldownChanged.fire(remaining);
            
            // If cooldown has expired, clear the interval
            if (remaining <= 0) {
                clearInterval(timer);
            }
        }, 1000);
    }

    /**
     * Sign a message with HMAC using the shared secret
     * @param message The message object to sign
     * @returns Object containing signature and timestamp
     */
    private signMessage(message: any): { signature: string, timestamp: string } {
        // Create a timestamp to prevent replay attacks
        const timestamp = Date.now().toString();
        
        // Create a clean version of the message without authentication data
        const cleanMessage = {
            type: message.type,
            username: message.username,
            tags: message.tags,
            message: message.message,
            timestamp: message.timestamp,
            avatarUrl: message.avatarUrl,
            snippet: message.snippet
        };
        
        // Create a string to sign (message content + timestamp)
        const messageStr = JSON.stringify(cleanMessage);
        const dataToSign = messageStr + timestamp;
        
        // Create HMAC signature
        const hmac = crypto.createHmac('sha256', config.signing.secret);
        hmac.update(dataToSign);
        const signature = hmac.digest('hex');
        
        return { signature, timestamp };
    }

    /**
     * Send a check-in message to the server
     * @param username GitHub username for the check-in
     * @param tags Language/technology tags for this check-in
     * @param message Optional short message
     * @param snippet Optional code snippet (will be overridden by random snippet)
     * @returns Promise resolving to boolean indicating success
     */
    public sendCheckIn(username: string, tags: string[], message: string = '', snippet?: string): Promise<boolean> {
        // Check if user is on cooldown
        if (!this.canCheckIn()) {
            return Promise.resolve(false);
        }
        
        // Enforce character limit of 42 characters
        const MAX_CHARS = 42;
        const truncatedMessage = message.length > MAX_CHARS ? message.substring(0, MAX_CHARS) : message;
        
        // Always use a random snippet from fml.json instead of any provided snippet
        const randomSnippet = this.getRandomSnippet();
        
        // Get the auth token and send the check-in
        return this.getAuthToken().then(token => {
            if (this.socket?.readyState === WebSocket.OPEN) {
                // Get GitHub avatar URL if username looks like a GitHub username
                const avatarUrl = `https://github.com/${username}.png`;
                
                const checkInMessage: CheckInMessage = {
                    type: 'checkin',
                    username,
                    tags,
                    message: truncatedMessage,
                    timestamp: new Date().toISOString(),
                    avatarUrl,
                    snippet: randomSnippet
                };
                
                // Sign the message
                const { signature, timestamp } = this.signMessage(checkInMessage);
                
                // Include authentication token and signature in the message
                const messageToSend = {
                    ...checkInMessage,
                    token: token, // This will be verified by the server
                    signature: signature,
                    signatureTimestamp: timestamp
                };
                
                this.socket.send(JSON.stringify(messageToSend));
                
                // Also create a self-update for our local view in case the server doesn't echo back
                const localUpdate: NewCheckInMessage = {
                    type: 'new_checkin',
                    username,
                    tags,
                    message: truncatedMessage,
                    timestamp: checkInMessage.timestamp,
                    avatarUrl,
                    snippet: randomSnippet
                };
                
                // Store in our own list
                this.storeCheckIn(localUpdate);
                
                // Small delay to simulate network roundtrip
                setTimeout(() => {
                    this._onMessageReceived.fire(localUpdate);
                }, 500);
                
                // Update the last check-in time and start cooldown
                this.lastCheckInTime = Date.now();
                this.startCooldownTimer();
                
                return true;
            } else {
                // Fall back to simulation if not connected
                if (this.simulateCheckInResponse(username, tags, message, randomSnippet)) {
                    // Update the last check-in time and start cooldown
                    this.lastCheckInTime = Date.now();
                    this.startCooldownTimer();
                    return true;
                }
                return false;
            }
        }).catch(error => {
            console.error('Error getting auth token for check-in:', error);
            
            // Still allow check-in without authentication in development
            if (this.simulateCheckInResponse(username, tags, message, randomSnippet)) {
                this.lastCheckInTime = Date.now();
                this.startCooldownTimer();
                return true;
            }
            return false;
        });
    }
    
    private simulateCheckInResponse(username: string, tags: string[], message: string = '', snippet?: string) {
        // Enforce character limit of 42 characters
        const MAX_CHARS = 42;
        const truncatedMessage = message.length > MAX_CHARS ? message.substring(0, MAX_CHARS) : message;
        
        // Get GitHub avatar URL
        const avatarUrl = `https://github.com/${username}.png`;
        
        const checkInMessage: NewCheckInMessage = {
            type: 'new_checkin',
            username,
            tags,
            message: truncatedMessage,
            timestamp: new Date().toISOString(),
            avatarUrl,
            snippet
        };
        
        // Store in our list
        this.storeCheckIn(checkInMessage);
        
        // Simulate a network delay
        setTimeout(() => {
            this._onMessageReceived.fire(checkInMessage);
        }, 500);
        
        return true;
    }
    
    private simulateData() {
        // Simulated data for development/demo purposes
        const sampleData: { username: string, tags: string[], message: string, avatarUrl?: string }[] = [
            { 
                username: 'johndoe', 
                tags: ['javascript', 'react', 'node'], 
                message: 'Working on a new feature for the dashboard',
                avatarUrl: 'https://github.com/octocat.png'
            },
            { 
                username: 'janedoe', 
                tags: ['python', 'django', 'ai'], 
                message: 'Debugging ML model training issues',
                avatarUrl: 'https://github.com/github.png'
            },
            { 
                username: 'bobsmith', 
                tags: ['java', 'spring', 'aws'], 
                message: 'Setting up CI/CD pipeline',
                avatarUrl: 'https://github.com/microsoft.png'
            },
            { 
                username: 'sarahlee', 
                tags: ['typescript', 'angular', 'azure'], 
                message: 'Refactoring authentication module',
                avatarUrl: 'https://github.com/google.png'
            },
            { 
                username: 'mikebrown', 
                tags: ['go', 'docker', 'kubernetes'], 
                message: 'Optimizing container orchestration',
                avatarUrl: 'https://github.com/facebook.png'
            }
        ];
        
        // Set simulated online users count
        this.onlineUsersCount = sampleData.length;
        this._onOnlineUsersChanged.fire(this.onlineUsersCount);
        
        // Emit sample check-ins with delays to simulate real-world behavior
        sampleData.forEach((data, index) => {
            setTimeout(() => {
                const message: NewCheckInMessage = {
                    type: 'new_checkin',
                    username: data.username,
                    tags: data.tags,
                    message: data.message,
                    timestamp: new Date(Date.now() - index * 60000).toISOString(), // Each one is a minute apart
                    avatarUrl: data.avatarUrl,
                    snippet: '' // Placeholder for snippet
                };
                
                // Store in our list
                this.storeCheckIn(message);
                
                this._onMessageReceived.fire(message);
                
                // Fire history received event after the last message
                if (index === sampleData.length - 1) {
                    this.initialHistoryReceived = true;
                    this._onHistoryReceived.fire();
                }
            }, index * 500); // Stagger by 500ms each
        });
        
        // Simulate connection status
        this._onConnectionStatusChanged.fire(true);
    }
    
    public dispose() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
    }
    
    /**
     * Properly disconnect the WebSocket
     */
    public disconnect() {
        console.log('Disconnecting WebSocket...');
        if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
            this.socket.close();
            this.socket = null; // Set to null instead of undefined to match property type
        }
        this._onConnectionStatusChanged.fire(false);
    }

    /**
     * Reconnect to the WebSocket server
     */
    public reconnect() {
        console.log('Attempting to reconnect WebSocket...');
        
        // Create a function to handle the actual connect operation
        const performConnect = () => {
            // Set a flag to prevent multiple reconnect attempts
            const reconnectAttemptId = Date.now();
            this._currentReconnectAttempt = reconnectAttemptId;
            
            setTimeout(() => {
                // Only proceed if this is still the current reconnect attempt
                if (this._currentReconnectAttempt === reconnectAttemptId) {
                    this.connect();
                    console.log('Reconnection attempt initiated');
                }
            }, 500); // Increase delay to 500ms to ensure socket is fully closed
        };
        
        // Handle existing connection
        if (this.socket) {
            if (this.socket.readyState !== WebSocket.CLOSED) {
                // Only disconnect if socket isn't already closed
                this.disconnect();
                // Wait longer after disconnect before reconnecting
                setTimeout(performConnect, 1000);
            } else {
                // Socket is already closed, can reconnect immediately
                performConnect();
            }
        } else {
            // No socket exists, can connect immediately
            performConnect();
        }
    }

    // Add tracking for current reconnect attempt
    private _currentReconnectAttempt: number = 0;

    /**
     * Updates the authentication status and manages the WebSocket connection accordingly
     * @param isAuthenticated Whether the user is authenticated
     */
    public updateAuthStatus(isAuthenticated: boolean): void {
        this.isAuthenticated = isAuthenticated;
        
        if (isAuthenticated) {
            // If authenticated and not connected, try to connect
            if (!this.isConnected() && this.autoReconnect) {
                this.connect();
            }
        } else {
            // If not authenticated, disconnect
            if (this.isConnected()) {
                this.disconnect();
            }
        }
    }
} 