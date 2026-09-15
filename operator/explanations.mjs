import {redact} from '../state/safe-boot/seed-lkg/codexless-runtime/src/operator-settings.mjs';
const concise=(s,max=1400)=>typeof s==='string'?redact(s).slice(0,max):null;
export function explainTask(task) {
 const pending=task.pendingApproval,details=pending?.details||{},kind=details.kind;
 const base={source:'按当前请求字段解释，不替你授权',requiresDecision:!!pending,title:'任务状态',action:null,scope:concise(task.cwd||task.project)||'尚未提供工作目录',reason:concise(pending?.reason||task.reason)||'执行器未说明额外原因。',impact:null,recommendation:null,canAutoApprove:false};
 if(!task.live)return {...base,title:'历史记录',recommendation:'这条记录不属于当前运行实例，仅供查看；不要重放旧审批。'};
 if(!pending)return {...base,title:task.status==='running'?'任务正在执行':'暂无待处理请求',recommendation:task.status==='unknown'?'先核验当前实例与任务状态，不要重复启动同一任务。':'可以继续查看进度和用量，无需反复提交启动。'};
 if(kind==='command')return {...base,title:'执行本机命令',action:concise(details.command,5000),scope:concise(details.cwd)||base.scope,impact:'命令可能读取、写入项目或启动子进程；以展示的完整命令和工作目录为准。',recommendation:'核对路径和参数是否属于这个任务。包含删除、安装、发布或权限变更时，应先确认具体影响；看不懂时先保留待处理。'};
 if(kind==='file'||kind==='fileChange'){const paths=details.paths||details.files||details.changes;return {...base,title:'修改项目文件',action:paths?concise(JSON.stringify(paths),5000):'执行器请求应用文件修改',impact:'批准后仅继续当前文件修改请求；不会自动批准之后的命令。',recommendation:'展开原始请求查看修改路径和差异，确认没有不相关文件。'};}
 if(kind==='permissions')return {...base,title:'申请额外访问权限',action:concise(JSON.stringify(details.permissions||{}),5000),impact:'这一轮将获得请求中列出的权限，可能扩大文件或网络访问范围。',recommendation:'核对是否确实需要新增范围；授权只针对这一项请求，不等于长期放开。'};
 if(kind==='elicitation')return {...base,title:details.requiresContent?'需要你填写信息':'请求你确认操作',action:concise(details.message)||'执行器请求输入或确认',scope:[details.serverName?'来源：'+concise(details.serverName):null,details.url?'地址：'+concise(details.url):null,details.requestedFields?.length?'字段：'+details.requestedFields.join('、'):null].filter(Boolean).join('；')||base.scope,impact:details.requiresContent?'填写的值会返回给发起此请求的工具。只提交你明确选择的信息。':'批准会向发起请求的工具返回同意，拒绝会返回不同意。',recommendation:details.requiresContent?'核对信息接收方及必填字段，不要用猜测值补齐。':'确认请求内容属于当前任务后再决定，普通“任务继续”不替代具体授权。'};
 return {...base,title:'等待处理请求',action:concise(details.humanText)||pending.method,impact:'当前类型的影响无法从摘要确认。',recommendation:'展开原始请求核对。不能识别时先保持待处理，不将未知请求自动批准。'};
}
