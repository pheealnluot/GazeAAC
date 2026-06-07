import { readFileSync } from 'fs';

// Helper to extract the outer object content by matching braces
function extractObjectContent(fileContent, markerRegex) {
  const match = fileContent.match(markerRegex);
  if (!match) return null;
  const startIndex = match.index + match[0].length - 1; // Position of the opening '{'
  let braceCount = 0;
  for (let i = startIndex; i < fileContent.length; i++) {
    if (fileContent[i] === '{') braceCount++;
    else if (fileContent[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        return fileContent.substring(startIndex + 1, i);
      }
    }
  }
  return null;
}

// Parse GazeSettingsContext.jsx DEFAULT_SETTINGS keys
const contextPath = 'src/context/GazeSettingsContext.jsx';
const contextContent = readFileSync(contextPath, 'utf8');
const defaultSettingsText = extractObjectContent(contextContent, /export\s+const\s+DEFAULT_SETTINGS\s*=\s*\{/);
if (!defaultSettingsText) {
  console.error('Failed to find DEFAULT_SETTINGS in GazeSettingsContext.jsx');
  process.exit(1);
}

const defaultKeys = [];
const keyRegex = /^\s*([a-zA-Z0-9_]+)\s*:/gm;
let match;
while ((match = keyRegex.exec(defaultSettingsText)) !== null) {
  defaultKeys.push(match[1]);
}

// Parse electron/main.js STORE_DEFAULTS keys
const mainPath = 'electron/main.js';
const mainContent = readFileSync(mainPath, 'utf8');
const storeDefaultsText = extractObjectContent(mainContent, /const\s+STORE_DEFAULTS\s*=\s*\{/);
if (!storeDefaultsText) {
  console.error('Failed to find STORE_DEFAULTS in electron/main.js');
  process.exit(1);
}

const storeKeys = [];
// Match keys at the root level of STORE_DEFAULTS
// A root-level key starts at the beginning of a line with optional spaces, followed by identifier and a colon.
const rootKeyRegex = /^\s*([a-zA-Z0-9_]+)\s*:/gm;
while ((match = rootKeyRegex.exec(storeDefaultsText)) !== null) {
  storeKeys.push(match[1]);
}

console.log('--- DEFAULT_SETTINGS Keys (' + defaultKeys.length + ') ---');
console.log('--- STORE_DEFAULTS Keys (' + storeKeys.length + ') ---');

const missingInStore = defaultKeys.filter(k => !storeKeys.includes(k));
const missingInDefault = storeKeys.filter(k => !defaultKeys.includes(k));

if (missingInStore.length > 0) {
  console.error('CRITICAL: Keys in DEFAULT_SETTINGS but missing in STORE_DEFAULTS (these will NOT persist!):');
  missingInStore.forEach(k => console.error('  -', k));
  process.exit(1);
} else {
  console.log('SUCCESS: All DEFAULT_SETTINGS keys exist in STORE_DEFAULTS.');
}

if (missingInDefault.length > 0) {
  console.log('INFO: Keys in STORE_DEFAULTS but missing in DEFAULT_SETTINGS:');
  missingInDefault.forEach(k => console.log('  -', k));
}

