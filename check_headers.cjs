/**
 * 模块说明：check_headers.cjs
 * 文件职责：扫描工作区清单中的文件头注释覆盖情况，并自动勾选已经具备模块说明的条目。
 * 维护说明：
 * - 该脚本只处理清单状态，不负责自动补写文件头；
 * - 若后续扩展资源文件豁免规则，请优先收敛到统一正则，避免重复判断逻辑分散。
 */
const fs = require('node:fs');

const checklistPath = 'f:/Y-Link/.trae/specs/review-entire-workspace-file-by-file/checklist.md';
let checklist = fs.readFileSync(checklistPath, 'utf8');

const lines = checklist.split('\n');
let updatedLines = [];
let missingFiles = [];

for (let line of lines) {
  const match = /- \[ \] `([^`]+)`/.exec(line);
  if (match) {
    const filePath = match[1];
    try {
      if (!fs.existsSync(filePath)) {
        updatedLines.push(line);
        continue;
      }
      
      const isResource = line.includes('资源文件登记') || /\.(png|svg|json|sqlite|sqlite-journal|lock|gitkeep|md)$/i.exec(filePath);
      
      if (isResource) {
        // Resources don't need headers, mark as checked
        updatedLines.push(line.replace('- [ ]', '- [x]'));
        continue;
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const hasHeader = content.includes('模块说明') || content.includes('文件职责') || content.includes('文件说明') || content.includes('模块职责');
      
      if (hasHeader) {
        updatedLines.push(line.replace('- [ ]', '- [x]'));
      } else {
        updatedLines.push(line);
        missingFiles.push(filePath);
      }
    } catch (error) {
      console.warn('跳过无法读取的文件:', filePath, error?.message ?? error);
      updatedLines.push(line);
    }
  } else {
    updatedLines.push(line);
  }
}

fs.writeFileSync(checklistPath, updatedLines.join('\n'));
console.log('Missing headers count:', missingFiles.length);
console.log('Missing files:', JSON.stringify(missingFiles.slice(0, 10), null, 2));
