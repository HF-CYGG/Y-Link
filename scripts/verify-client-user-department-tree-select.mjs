import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const viewPath = join(process.cwd(), 'src/views/system/ClientUserManageView.vue')
const source = readFileSync(viewPath, 'utf8')

const fail = (message) => {
  throw new Error(message)
}

const assertIncludes = (needle, message) => {
  if (!source.includes(needle)) {
    fail(message)
  }
}

const assertPattern = (pattern, message) => {
  if (!pattern.test(source)) {
    fail(message)
  }
}

const createDepartmentField = source.match(
  /<el-form-item v-if="!isCreateTeacherProfile"[\s\S]*?prop="departmentName"[\s\S]*?<\/el-form-item>/,
)?.[0]

if (!createDepartmentField) {
  fail('missing create dialog department form item')
}

assertIncludes('type ClientDepartmentTreeNode', 'ClientDepartmentTreeNode type must be reused from system config API')
assertIncludes('const departmentTree = ref<ClientDepartmentTreeNode[]>([])', 'department tree state must be stored')
assertIncludes('type DepartmentTreeSelectOption', 'tree select option type must be declared')
assertIncludes('const departmentTreeSelectOptions = computed(() =>', 'tree select options must be computed')
assertIncludes('const value = parentPath ? `${parentPath}-${label}` : label', 'child department value must keep full path')
assertIncludes('const departmentTreeSelectProps = {', 'tree select props must be defined')
assertPattern(/departmentTree\.value\s*=\s*result\.tree/, 'loadDepartmentOptions must store result.tree')

if (!createDepartmentField.includes('<el-tree-select')) {
  fail('create dialog department field must use el-tree-select')
}

for (const [needle, message] of [
  ['v-model="createForm.departmentName"', 'create tree select must bind createForm.departmentName'],
  ['filterable', 'create tree select must be filterable'],
  ['clearable', 'create tree select must be clearable'],
  ['check-strictly', 'create tree select must allow selecting parent departments'],
  ['node-key="value"', 'create tree select must use value as node key'],
  [':data="departmentTreeSelectOptions"', 'create tree select must use converted tree data'],
  [':props="departmentTreeSelectProps"', 'create tree select must use explicit props'],
  [':disabled="departmentOptionsLoading || departmentOptions.length === 0"', 'create tree select must be disabled without department config'],
]) {
  if (!createDepartmentField.includes(needle)) {
    fail(message)
  }
}

if (createDepartmentField.includes('<el-select') || createDepartmentField.includes('<el-option')) {
  fail('create dialog department field must not keep the flat el-select option list')
}

if (createDepartmentField.includes('default-expanded-keys')) {
  fail('create dialog department tree select must stay collapsed by default')
}

console.log('client user create department tree select checks passed')
