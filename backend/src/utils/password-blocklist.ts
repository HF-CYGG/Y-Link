/**
 * 文件说明：常见弱口令黑名单（NIST SP 800-63B-4：新设或修改密码时必须与常用、可预期或已泄露口令比对，整串比较）。
 * 实现逻辑：
 * - 只收录满足本系统基础规则（至少 8 位、同时含字母与数字）的高频口令，其余口令已被基础规则拦下；
 * - 覆盖国际常见泄露口令、中文环境高频口令（拼音姓氏 + 数字、谐音数字、QQ/键盘序列）以及本系统名称派生口令；
 * - 比较前统一转小写，大小写变体视为同一口令。
 * 维护说明：条目只增不减；新增时保持小写，并确认不会误伤验证脚本中使用的测试口令。
 */

const COMMON_WEAK_PASSWORDS = [
  // 国际常见泄露口令（字母 + 数字）
  'password1', 'password12', 'password123', 'password1234', 'password12345', 'passw0rd', 'passw0rd1', 'p@ssw0rd',
  'p@ssw0rd1', 'p@ssword1', 'pa55word', 'pa55w0rd', 'welcome1', 'welcome12', 'welcome123', 'letmein1', 'letmein123',
  'iloveyou1', 'iloveyou12', 'iloveyou123', 'sunshine1', 'princess1', 'football1', 'baseball1', 'monkey123',
  'dragon123', 'master123', 'shadow123', 'superman1', 'batman123', 'trustno1', 'michael1', 'charlie1', 'jennifer1',
  'computer1', 'internet1', 'freedom1', 'whatever1', 'starwars1', 'pokemon123', 'hello1234', 'hello12345',
  'secret123', 'changeme1', 'changeme123', 'default1', 'default123', 'temp1234', 'temp12345', 'test1234',
  'test12345', 'test123456', 'testtest1', 'user1234', 'user12345', 'guest1234', 'demo1234', 'login1234',
  'admin123', 'admin1234', 'admin12345', 'admin123456', 'admin888', 'admin8888', 'admin666', 'admin2023',
  'admin2024', 'admin2025', 'admin2026', 'administrator1', 'root1234', 'root12345', 'root123456', 'system123',
  'manager123', 'password2023', 'password2024', 'password2025', 'password2026',
  // 键盘与数字序列
  'qwerty123', 'qwerty1234', 'qwerty12345', 'qwerty123456', 'qwer1234', 'qwer12345', 'qwe123456', 'qwe12345',
  'qweasd123', 'qweasdzxc1', 'asdf1234', 'asdf12345', 'asd123456', 'asd12345', 'zxcv1234', 'zxcvbnm1',
  'zxcvbnm123', 'zxc123456', 'zxc12345', '1qaz2wsx', '1qaz2wsx3edc', '1q2w3e4r', '1q2w3e4r5t', '1q2w3e4r5t6y',
  'q1w2e3r4', 'q1w2e3r4t5', 'zaq12wsx', 'zaq1xsw2', 'qazwsx123', 'qazwsxedc1', '1qazxsw2', 'a1s2d3f4',
  '123qwe123', '123qweasd', '123qwe456', 'qwe123qwe', 'abc123abc', 'abcd1234', 'abcd12345', 'abcd123456',
  'abc12345', 'abc123456', 'abc1234567', 'abc12345678', 'a1234567', 'a12345678', 'a123456789', 'a1234567890',
  'a1b2c3d4', 'a1b2c3d4e5', '1a2b3c4d', '1234abcd', '12345678a', '123456789a', '1234567a', '123456abc',
  '12345abc', '12345qwe', '123456qwe', '123456aa', '123456asd', 'aa123456', 'aa12345678', 'aaa12345',
  'aaa123456', 'aaaa1111', 'aaaa1234', 'a11111111', 'a1111111', 'a0000000', 'a00000000', 'aa112233',
  'a112233', 'a123123123', 'a123123', 'abc123123', 'a321321', 'asdasd123', 'qweqwe123', 'zxczxc123',
  'q1234567', 'q12345678', 'q123456789', 'z1234567', 'z12345678', 'w1234567', 'w12345678', 'x12345678',
  // 中文环境高频口令（谐音、拼音姓氏 + 数字）
  'woaini1314', 'woaini520', 'woaini123', 'woaini1234', 'woaini12345', 'woainia1', '5201314a', 'a5201314',
  '5201314abc', 'aini1314', 'aini520', 'love1314', 'love5201314', 'iloveyou520', 'iloveyou1314', 'qq123456',
  'qq1234567', 'qq12345678', 'qq5201314', 'wang123456', 'wang12345', 'zhang123456', 'zhang12345', 'li123456',
  'li1234567', 'liu123456', 'chen123456', 'yang123456', 'huang123456', 'zhao123456', 'wu123456', 'zhou123456',
  'xu123456', 'sun123456', 'ma123456', 'zhu123456', 'hu123456', 'guo123456', 'he123456', 'lin123456',
  'luo123456', 'gao123456', 'liang123456', 'song123456', 'tang123456', 'han123456', 'feng123456', 'dong123456',
  'baobao123', 'baobei123', 'baobei520', 'xiaoming1', 'xiaohong1', 'nihao123', 'nihao1234', 'shabi123',
  'zhongguo1', 'china123', 'china1234', 'beijing123', 'shanghai1', 'woshishui1', 'mima1234', 'mima123456',
  // 本系统名称派生口令
  'ylink123', 'ylink1234', 'ylink12345', 'ylink123456', 'ylink2024', 'ylink2025', 'ylink2026', 'ylinkadmin1',
] as const

const COMMON_WEAK_PASSWORD_SET: ReadonlySet<string> = new Set(COMMON_WEAK_PASSWORDS)

export function isCommonWeakPassword(plainPassword: string): boolean {
  return COMMON_WEAK_PASSWORD_SET.has(plainPassword.trim().toLowerCase())
}
