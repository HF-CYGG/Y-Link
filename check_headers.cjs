const fs = require('fs');
const path = require('path');

const checklistPath = 'f:/Y-Link/.trae/specs/review-entire-workspace-file-by-file/checklist.md';
let checklist = fs.readFileSync(checklistPath, 'utf8');

const lines = checklist.split('\n');
let updatedLines = [];
let skippedFiles = [];
let missingFiles = [];

for (let line of lines) {
  const match = line.match(/- \[ \] \`([^\`]+)\`/);
  if (match) {
    const filePath = match[1];
    try {
      if (!fs.existsSync(filePath)) {
        updatedLines.push(line);
        continue;
      }
      
      const isResource = line.includes('资源文件登记') || filePath.match(/\.(png|svg|json|sqlite|sqlite-journal|lock|gitkeep|md)$/i);
      
      if (isResource) {
        // Resources don't need headers, mark as checked
        updatedLines.push(line.replace('- [ ]', '- [x]'));
        continue;
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const hasHeader = content.includes('模块说明') || content.includes('文件职责') || content.includes('文件说明') || content.includes('模块职责');
      
      if (hasHeader) {
        updatedLines.push(line.replace('- [ ]', '- [x]'));
        skippedFiles.push(filePath);
      } else {
        updatedLines.push(line);
        missingFiles.push(filePath);
      }
    } catch (e) {
      updatedLines.push(line);
    }
  } else {
    updatedLines.push(line);
  }
}

fs.writeFileSync(checklistPath, updatedLines.join('\n'));
console.log('Missing headers count:', missingFiles.length);
console.log('Missing files:', JSON.stringify(missingFiles.slice(0, 10), null, 2));
