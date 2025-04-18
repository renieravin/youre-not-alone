import * as vscode from 'vscode';
import { FileHistoryTracker } from './fileHistoryTracker';
import * as path from 'path';

/**
 * Get tags based on all open files and recent file history
 * @returns Array of tags based on all open files and recent history, limited to max 3 tags
 */
export function getActiveFileTags(): string[] {
    const allTags: string[] = [];
    const processedFiles = new Set<string>();
    
    // Process visible editors
    const visibleEditors = vscode.window.visibleTextEditors;
    
    // Process all visible editors
    visibleEditors.forEach(editor => {
        const document = editor.document;
        
        // Skip non-file documents
        if (document.uri.scheme !== 'file') {
            return;
        }
        
        const filePath = document.fileName;
        processedFiles.add(filePath);
        
        processFileForTags(filePath, document.languageId, allTags);
    });
    
    // Also process recent files from history
    const fileTracker = FileHistoryTracker.getInstance();
    const recentFiles = fileTracker.getRecentFiles();
    
    recentFiles.forEach(filePath => {
        // Skip files we already processed from visible editors
        if (processedFiles.has(filePath)) {
            return;
        }
        
        // For files not currently open, try to determine language from extension
        const fileExtension = path.extname(filePath).toLowerCase().replace('.', '');
        processFileForTags(filePath, null, allTags);
    });
    
    // Check for package.json to detect Node.js project
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        const packageJsonPath = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'package.json');
        try {
            // This is async but we'll skip waiting for simplicity
            vscode.workspace.fs.stat(packageJsonPath).then(
                () => {
                    if (!allTags.includes('nodejs')) {
                        allTags.push('nodejs');
                    }
                },
                () => { /* Ignore errors */ }
            );
        } catch {
            // Ignore errors
        }
    }
    
    // Remove duplicates
    const uniqueTags = [...new Set(allTags)];
    
    // Limit to maximum 3 tags
    const limitedTags = uniqueTags.slice(0, 3);
    
    return limitedTags;
}

/**
 * Process a file to extract tags based on language and extension
 */
function processFileForTags(filePath: string, languageId: string | null, allTags: string[]): void {
    // Add language as a tag if provided and not plaintext
    if (languageId && languageId !== 'plaintext') {
        allTags.push(languageId);
    }
    
    // Add file extension-based tags
    const fileExtension = path.extname(filePath).toLowerCase().replace('.', '');
    if (fileExtension) {
        // Map file extensions to common frameworks/technologies
        const extensionMappings: Record<string, string[]> = {
            'jsx': ['react'],
            'tsx': ['react', 'typescript'],
            'vue': ['vue'],
            'svelte': ['svelte'],
            'ts': ['typescript'],
            'py': ['python'],
            'rb': ['ruby'],
            'php': ['php'],
            'go': ['golang'],
            'rs': ['rust'],
            'java': ['java'],
            'cs': ['csharp', 'dotnet'],
            'fs': ['fsharp', 'dotnet'],
            'sql': ['database', 'sql'],
            'dart': ['flutter', 'dart'],
            'kt': ['kotlin'],
            'swift': ['swift', 'ios'],
            'scala': ['scala'],
            'clj': ['clojure'],
            'elm': ['elm'],
            'ex': ['elixir'],
            'hs': ['haskell'],
            'r': ['r'],
            'toml': ['configuration'],
            'yaml': ['configuration'],
            'yml': ['configuration'],
            'json': ['json'],
            'md': ['markdown'],
            'html': ['html'],
            'css': ['css'],
            'scss': ['scss', 'css'],
            'less': ['less', 'css']
        };
        
        if (extensionMappings[fileExtension]) {
            allTags.push(...extensionMappings[fileExtension]);
        }
    }
} 