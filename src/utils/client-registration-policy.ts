/** 新个人注册专用；不清洗非法字符，不影响旧姓名登录及教师目录。与后端同规则。 */
export const CLIENT_REGISTRATION_USERNAME_HINT = '请输入 2-20 位中文或英文字母，不允许数字、空格或特殊字符'
export const isPersonalRegistrationUsernameValid = (value: string): boolean => /^[\p{Script=Han}A-Za-z]{2,20}$/u.test(value)
