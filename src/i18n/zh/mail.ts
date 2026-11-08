export const mail = {
  error: {
    connect: "邮箱连接失败，请检查服务器地址和端口",
    auth: "邮箱密码或授权码不对，请在桌面端更新密钥",
    folder: "邮箱里没有这个文件夹",
    missing: "邮箱里没有这封邮件，请重新搜索",
    account: "没有这个邮箱账号：{id}",
    term: "搜索词里不能有换行",
    tooLarge: "邮件 {size} MB，超过 15 MB 上限",
    timeout: "邮箱响应太慢，这次没有取到结果",
  },
  progress: {
    search: "搜邮件：{query}",
    read: "读邮件：uid {uid}",
  },
  section: {
    title: "可用邮箱账号：{accounts}",
    rules: "只能读：搜索、读正文、看附件清单。不要用这些账号以外的信息猜测邮箱。",
    omitted: "未指定账号时默认用第一个。",
  },
  result: {
    empty: "没有找到符合条件的邮件",
    list: "共 {total} 封，显示前 {shown} 封（账号 {account}）",
    headerOnly: "只在最近 {scanned} 封里找过（服务器不支持中文全文搜索）",
    attachments: "附件 {count} 个：{list}",
    noBody: "这封邮件没有可读的正文",
    truncated: "正文已截断，原文 {total} 字",
  },
} as const;
