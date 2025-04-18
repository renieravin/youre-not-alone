import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Class to track recently edited files in the current session
 */
export class FileHistoryTracker {
    private static instance: FileHistoryTracker;
    private recentFiles: Set<string> = new Set();
    private maxHistorySize: number = 30;

    private constructor() {
        // Initialize with the current active editor if any
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.scheme === 'file') {
            const fileName = activeEditor.document.fileName as string;
            this.addFile(fileName);
        }
    }

    /**
     * Get the singleton instance
     */
    public static getInstance(): FileHistoryTracker {
        if (!FileHistoryTracker.instance) {
            FileHistoryTracker.instance = new FileHistoryTracker();
        }
        return FileHistoryTracker.instance;
    }

    /**
     * Add a file to the history
     */
    public addFile(filePath: string): void {
        // Remove if already exists (to make it most recent)
        if (this.recentFiles.has(filePath)) {
            this.recentFiles.delete(filePath);
        }
        
        // Add to the set
        this.recentFiles.add(filePath);
        
        // Trim if exceeds max size
        if (this.recentFiles.size > this.maxHistorySize) {
            const oldest = this.recentFiles.values().next().value;
            if (oldest !== undefined) {
                this.recentFiles.delete(oldest);
            }
        }
    }

    /**
     * Get all recent file paths
     */
    public getRecentFiles(): string[] {
        return Array.from(this.recentFiles);
    }

    /**
     * Clear history
     */
    public clear(): void {
        this.recentFiles.clear();
    }
} 