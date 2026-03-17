import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function run(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run('brain extract_actions exposes mermaid_code and title for generate_diagram', () => {
  const source = read('server/brain.py');

  assert.match(source, /"action": "generate_diagram"/);
  assert.match(source, /"mermaid_code": tool_result\.get\("mermaid_code", ""\)/);
  assert.match(source, /"title": tool_result\.get\("title",/);
});

run('useBrain defines onDiagram with mermaidCode and title', () => {
  const source = read('src/hooks/useBrain.ts');

  assert.match(source, /onDiagram\?: \(mermaidCode: string, title: string\) => void;/);
});

run('useBrain forwards title from brain action into onDiagram callback', () => {
  const source = read('src/hooks/useBrain.ts');

  assert.match(
    source,
    /callbacksRef\.current\?\.onDiagram\?\.\(\s*\(action\.data\.mermaid_code as string\) \|\| ""\s*,\s*\(action\.data\.title as string\) \|\| ""\s*\)/
  );
});

run('LivePanel persists diagram title and mermaidDefinition to Firebase', () => {
  const source = read('src/components/live-panel/LivePanel.tsx');

  assert.match(source, /onDiagram: \(mermaidCode: string, title: string\) => \{/);
  assert.match(source, /title: title \|\|/);
  assert.match(source, /mermaidDefinition: mermaidCode/);
});
