/** Shared factual reference for interview prompts and the question-bank reader. */
export const technicalKnowledge = [
  { title: "接口重试与幂等", terms: ["幂等","idempotency","idempotent","重复提交","duplicate request"], note: "请求超时可能意味着服务端已经成功。用业务幂等键关联请求、结果和唯一约束，保证并发重试不会重复扣款；同键不同参数要拒绝。" },
  { title: "SQL 索引与慢查询", terms: ["索引","index","indexes","indexing","慢查询","slow query","query plan"], note: "从高频查询及执行计划出发，检查扫描行数、过滤条件和排序。复合索引的列序要配合查询；新索引会增加写入和存储成本。" },
  { title: "事务与并发更新", terms: ["事务","隔离级别","transaction","isolation","lost update","乐观锁"], note: "先指出要保护的业务不变量，再比较隔离级别、行锁和带版本号的条件更新。发生冲突时检查重试是否安全。" },
  { title: "缓存一致性", terms: ["缓存","cache","caching","缓存穿透"], note: "以数据库为准，读时回填、更新后失效。考虑并发旧值回填、失效失败、热点过期；用版本校验或短 TTL 限制脏读窗口。" },
  { title: "消息队列与重复消费", terms: ["消息队列","重复消费","message queue","at-least-once","消息积压","kafka"], note: "至少一次投递可能重复。持久化处理结果后确认消费，用事件 ID 去重；监控消费延迟，隔离反复失败的消息。" },
  { title: "限流与背压", terms: ["限流","背压","rate limit","backpressure","load shedding"], note: "按租户或资源限制速率与并发，队列设上限。过载时拒绝或降级，客户端退避并加抖动；观察等待时间和拒绝率。" },
  { title: "并发与异步 I/O", terms: ["并发","异步","concurrency","async","event loop","事件循环"], note: "I/O 等待适合异步，CPU 密集任务会阻塞事件循环，可分给工作线程或进程；限制并发数以保护连接池和下游。" },
  { title: "测试策略", terms: ["单元测试","集成测试","unit test","integration test","testing strategy","端到端测试"], note: "用单元测试覆盖业务边界，集成测试覆盖真实存储和服务契约，端到端测试保留关键路径；加入超时、重试和部分成功用例。" },
  { title: "发布与回滚", terms: ["灰度","回滚","canary","rollback","deployment","持续交付"], note: "小流量发布后对比错误率、延迟与核心业务指标。数据库字段先做兼容性扩展，再切换读写；回滚代码前确认能读取新数据。" },
  { title: "性能定位与可观测性", terms: ["可观测性","性能瓶颈","p95","p99","observability","latency","慢请求"], note: "先按请求类型建立基线，再用追踪拆分排队、数据库和下游耗时；用性能剖析定位热点，在相同负载下复测尾延迟。" },
  { title: "API 分页", terms: ["分页","pagination","cursor pagination","offset pagination"], note: "偏移分页实现简单，大偏移读取成本较高。游标分页使用稳定排序及唯一键作为平局条件，并约定并发插入时的一致性语义。" },
  { title: "接口兼容性", terms: ["向后兼容","backward compatibility","api versioning","接口版本"], note: "优先新增可选字段，明确缺省值和未知枚举处理；破坏性变更需分版本迁移，用契约测试验证旧客户端。" },
  { title: "RAG 流程", terms: ["rag","检索增强","retrieval augmented","retrieval-augmented"], note: "建库时解析、切块并保留来源和权限；查询时检索、重排、生成并校验引用。先区分检索没找到证据，还是模型误用了已有证据。" },
  { title: "文档切块", terms: ["切块","分块","chunking","chunk size"], note: "按段落、标题或语义边界切块；块太短丢上下文，太长会稀释相关性。用真实问题比较召回、重复片段和上下文成本。" },
  { title: "向量检索", terms: ["向量检索","embedding","vector search","向量索引"], note: "保持文档和查询编码方式兼容，按模型约定选距离度量。近似检索需权衡召回率、内存和耗时，换模型时应重建或分版本索引。" },
  { title: "混合检索与重排", terms: ["混合检索","重排","hybrid search","rerank","bm25","rrf"], note: "关键词检索擅长型号和精确术语，向量检索补充同义表达。可用 RRF 按排名融合，再对少量候选重排，比较准确率和新增延迟。" },
  { title: "检索质量评估", terms: ["检索评估","检索质量","recall@k","mrr","retrieval evaluation","evaluate retrieval"], note: "构建带相关文档标注的留出问题集；Recall@k 看找全程度，MRR 看首个相关结果的位置。按问题类型分析，再单独评价生成质量。" },
  { title: "幻觉与证据", terms: ["幻觉","hallucination","grounding","faithfulness"], note: "要求答案引用证据，逐条核对主张是否受原文支持；证据不足时澄清或明确未知。降低温度无法保证事实正确。" },
  { title: "提示词与微调", terms: ["微调","fine-tuning","fine tuning","lora","prompt engineering"], note: "先用提示词建立可测基线。频繁变化的知识宜检索更新；稳定的格式或行为偏差可考虑微调，使用留出集验证收益及退化。" },
  { title: "结构化输出", terms: ["结构化输出","structured output","json schema"], note: "用 schema 限定字段、类型与枚举，服务端另校验业务约束。格式合规不代表事实正确；无效结果有限重试并保留失败样本。" },
  { title: "工具调用与智能体", terms: ["工具调用","智能体","tool calling","function calling","agent"], note: "由模型提出工具与参数，应用校验权限和参数并执行。限制步骤、预算和重试，对有副作用的调用做幂等处理，必要时请求确认。" },
  { title: "模型评测与回归", terms: ["模型评测","模型评估","llm eval","model evaluation","模型回归"], note: "用版本固定的代表性样本和评分标准比较新旧方案。分别记录正确性、拒答、延迟和成本，人工抽查自动评分分歧。" },
  { title: "大模型延迟与成本", terms: ["首字延迟","token","ttft","模型成本","llm latency","推理成本"], note: "区分排队、首 token 延迟与生成速度；控制无关上下文和输出长度、复用稳定前缀。按请求类型同时比较质量、成本和尾延迟。" },
  { title: "知识库更新与权限", terms: ["知识库更新","权限过滤","document permissions","metadata filter","增量索引"], note: "文档以稳定 ID 和版本增量更新；删除时同步清理旧块。检索阶段按用户权限过滤，并验证引用链接与缓存也遵守相同权限。" },
];

export function technicalReference(question: string): string {
  const words = new Set(question.toLowerCase().match(/[a-z0-9@-]+/g) ?? []);
  const text = question.toLowerCase();
  const ranked = technicalKnowledge.map((entry) => ({
    entry, score: entry.terms.filter((term) => /^[a-z0-9@-]+$/.test(term) ? words.has(term) : text.includes(term)).length,
  })).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score);
  if (!ranked.length) return '';
  return '【通用专业知识】结合本场 JD 选择相关取舍；仅简历或已确认资料能证明个人经历。\n' +
    ranked.slice(0, 3).map(({ entry }) => entry.title + '：' + entry.note).join('\n');
}
