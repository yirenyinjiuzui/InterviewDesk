import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import {
  SseParser,
  extractDelta,
  extractMessageText,
  toProxyRules,
  chatOnce,
  chatStream,
  type ChatMessage,
} from '../electron/llm/adapter';
import {
  buildAnswerMessages,
  buildMemoUpdateMessages,
  buildPrewarmMessages,
  buildStablePrefix,
  buildTranslateMessages,
  buildVisionMessages,
  clampMemo,
  clampTranscript,
  classifyQuestion,
  isLikelyQuestion,
  langDirective,
  questionHint,
  smartClip,
  JD_PRIORITY,
  MAX_BACKGROUND_CHARS,
  MAX_CONTEXT_CHARS,
  MAX_MEMO_CHARS,
  RESUME_PRIORITY,
} from '../electron/llm/prompts';

describe('SseParser', () => {
  it('parses complete events', () => {
    const p = new SseParser();
    expect(p.push('data: {"a":1}\n\ndata: {"b":2}\n\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles payloads split across chunks', () => {
    const p = new SseParser();
    expect(p.push('data: {"a"')).toEqual([]);
    expect(p.push(':1}\n')).toEqual(['{"a":1}']);
  });

  it('handles CRLF and ignores non-data lines', () => {
    const p = new SseParser();
    expect(p.push(': comment\r\nevent: x\r\ndata: {"a":1}\r\n\r\n')).toEqual(['{"a":1}']);
  });

  it('stops at [DONE]', () => {
    const p = new SseParser();
    expect(p.push('data: {"a":1}\n\ndata: [DONE]\n\ndata: {"b":2}\n\n')).toEqual(['{"a":1}']);
    expect(p.done).toBe(true);
    expect(p.push('data: {"c":3}\n\n')).toEqual([]);
  });
});

describe('extractDelta', () => {
  it('extracts streaming delta content', () => {
    expect(extractDelta('{"choices":[{"delta":{"content":"你好"}}]}')).toBe('你好');
  });
  it('tolerates role-only/empty deltas and bad json', () => {
    expect(extractDelta('{"choices":[{"delta":{"role":"assistant"}}]}')).toBe('');
    expect(extractDelta('not json')).toBe('');
  });
});

describe('buildAnswerMessages', () => {
  it('segment mode quotes the target sentence and includes context', () => {
    const msgs = buildAnswerMessages({
      mode: 'segment',
      question: '你们的核心优势是什么？',
      recentTranscript: ['我们先自我介绍', '你们的核心优势是什么？'],
    });
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].content).toContain('你们的核心优势是什么？');
    expect(msgs[1].content).toContain('我们先自我介绍');
  });

  it('continuous mode without a resolved question falls back to the latest speech', () => {
    const msgs = buildAnswerMessages({ mode: 'continuous', recentTranscript: ['刚才那句'] });
    expect(msgs[1].content).toContain('面试官最新的话');
  });

  it('continuous mode with the resolved question quotes it (v1 label bug fix)', () => {
    const msgs = buildAnswerMessages({
      mode: 'continuous',
      question: '你为什么从上一家公司离职？',
      recentTranscript: ['寒暄', '你为什么从上一家公司离职？'],
    });
    const user = msgs[msgs.length - 1].content as string;
    expect(user).toContain('你为什么从上一家公司离职？');
    expect(user).not.toContain('对方最新发言');
  });

  it('teleprompter persona: first-person, read-aloud output', () => {
    const msgs = buildAnswerMessages({ mode: 'segment', question: 'x', recentTranscript: [] });
    const sys = msgs[0].content as string;
    expect(sys).toContain('提词');
    expect(sys).toContain('第一人称');
    expect(sys).toContain('照着念');
    expect(sys).toContain('绝不编造');
    expect(sys).toContain('STAR');
    expect(sys).toContain('复杂度');
    expect(sys).not.toContain('通常不超过三句');
  });

  it('free mode passes the user question through', () => {
    const msgs = buildAnswerMessages({
      mode: 'free',
      freeQuestion: '帮我总结一下刚才的对话',
      recentTranscript: [],
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('STAR');
    expect(msgs[0].content).not.toContain('通常不超过三句');
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toBe('帮我总结一下刚才的对话');
  });

  it('free mode does NOT inject the meeting-assistant persona (truthful model identity)', () => {
    const withCtx = buildAnswerMessages({
      mode: 'free',
      freeQuestion: '你是什么模型',
      recentTranscript: ['对方说了些话'],
      background: '我的简历',
    });
    const joined = JSON.stringify(withCtx);
    expect(joined).not.toContain('实时会议/面试助手');
    expect(joined).not.toContain('帮用户想好接下来怎么回答');
    // reference material is offered, not a persona
    expect(joined).toContain('供参考');
    expect(withCtx[withCtx.length - 1].content).toBe('你是什么模型');
  });

  it('answerLang hook steers the reply language (default chinese)', () => {
    const zh = buildAnswerMessages({ mode: 'segment', question: 'x', recentTranscript: [] });
    expect(zh[0].content).toContain('【中文】');
    expect(zh[0].content).not.toContain('【英文】');

    const en = buildAnswerMessages({
      mode: 'segment',
      question: 'x',
      recentTranscript: [],
      answerLang: 'english',
    });
    expect(en[0].content).toContain('【英文】');
    expect(en[0].content).not.toContain('- 用【中文】回答');

    const enCont = buildAnswerMessages({
      mode: 'continuous',
      recentTranscript: ['a'],
      answerLang: 'english',
    });
    expect(enCont[0].content).toContain('【英文】');
  });
});

describe('isLikelyQuestion (continuous-mode gate)', () => {
  it('accepts real questions (zh + en)', () => {
    expect(isLikelyQuestion('你们的核心优势是什么？')).toBe(true);
    expect(isLikelyQuestion('能不能介绍一下你的项目')).toBe(true);
    expect(isLikelyQuestion('请问你怎么看这个方向')).toBe(true);
    expect(isLikelyQuestion('Could you tell me about your experience?')).toBe(true);
    expect(isLikelyQuestion('How do you handle conflict')).toBe(true);
  });
  it('rejects short/statement fragments', () => {
    expect(isLikelyQuestion('嗯')).toBe(false);
    expect(isLikelyQuestion('好的')).toBe(false);
    expect(isLikelyQuestion('我明白了')).toBe(false);
  });
  it('does not treat length alone as a question', () => {
    const long = '我们这边其实一直在做这个方向的落地大概有三年了积累了不少经验和数据也踩过很多坑希望多交流一下';
    expect(long.length).toBeGreaterThanOrEqual(40);
    expect(isLikelyQuestion(long)).toBe(false);
  });
});

describe('buildAnswerMessages history (session coherence)', () => {
  it('injects prior Q&A between system and the new user turn', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '上一个问题' },
      { role: 'assistant', content: '上一个回答' },
    ];
    const msgs = buildAnswerMessages({
      mode: 'segment',
      question: '新问题',
      recentTranscript: [],
      history,
    });
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].content).toContain('此前问题／手动输入：上一个问题');
    expect(msgs[1].content).toContain('AI 建议（未实际说出）：上一个回答');
    expect(msgs.slice(1).every((m) => m.role !== 'assistant')).toBe(true);
    expect(msgs[msgs.length - 1].content).toContain('新问题');
  });
  it('translate mode ignores history entirely', () => {
    const msgs = buildAnswerMessages({
      mode: 'translate',
      question: 'Hello',
      recentTranscript: [],
      history: [{ role: 'user', content: 'leak?' }],
    });
    expect(JSON.stringify(msgs)).not.toContain('leak?');
  });
});

describe('dual-slot material injection (resume / JD)', () => {
  it('injects resume + JD as delimited sections of the system prompt', () => {
    const msgs = buildAnswerMessages({
      mode: 'segment',
      question: 'x',
      recentTranscript: [],
      resume: '我做过一个实时音频转录项目，用 whisper + DirectML。',
      jd: '岗位职责：负责语音产品研发。',
    });
    const sys = msgs[0].content as string;
    expect(sys).toContain('【简历】');
    expect(sys).toContain('DirectML');
    expect(sys).toContain('【岗位JD】');
    expect(sys).toContain('语音产品研发');
  });
  it('legacy background is treated as resume material (compat)', () => {
    const msgs = buildAnswerMessages({
      mode: 'segment',
      question: 'x',
      recentTranscript: [],
      background: '我的全局知识库内容',
    });
    const sys = msgs[0].content as string;
    expect(sys).toContain('【简历】');
    expect(sys).toContain('我的全局知识库内容');
  });
  it('omits sections when empty', () => {
    const msgs = buildAnswerMessages({ mode: 'segment', question: 'x', recentTranscript: [], background: '  ' });
    const sys = msgs[0].content as string;
    // the persona text may mention 【简历】 in its rules — check section headers
    expect(sys).not.toContain('【简历】（');
    expect(sys).not.toContain('【岗位JD】（');
    expect(sys).not.toContain('【简历结束】');
  });
  it('caps oversized material to the char budget', () => {
    const huge = 'A'.repeat(20000);
    const msgs = buildAnswerMessages({ mode: 'segment', question: 'x', recentTranscript: [], resume: huge });
    const sys = msgs[0].content as string;
    // system prompt = persona + <=8000 material chars + delimiters
    expect(sys.length).toBeLessThan(9000);
  });
  it('translate mode never carries material', () => {
    const msgs = buildAnswerMessages({
      mode: 'translate',
      question: 'Hello',
      recentTranscript: [],
      resume: '机密简历内容',
      jd: '机密JD内容',
    });
    const joined = JSON.stringify(msgs);
    expect(joined).not.toContain('机密简历内容');
    expect(joined).not.toContain('机密JD内容');
  });
});

describe('buildStablePrefix (prefix-cache friendliness)', () => {
  it('is byte-stable: identical inputs yield the identical string', () => {
    const a = buildStablePrefix('简历内容', 'JD内容', 'chinese');
    const b = buildStablePrefix('简历内容', 'JD内容', 'chinese');
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{13}/); // no dates / timestamps
  });
  it('is the entire system message of segment/continuous requests', () => {
    const prefix = buildStablePrefix('R', 'J', 'english');
    const msgs = buildAnswerMessages({
      mode: 'segment',
      question: 'q',
      recentTranscript: ['a'],
      resume: 'R',
      jd: 'J',
      answerLang: 'english',
    });
    expect(msgs[0].content).toBe(prefix);
  });
  it('gives the full budget to a lone slot', () => {
    const huge = 'B'.repeat(20000);
    const p = buildStablePrefix('', huge, 'chinese');
    expect(p).toContain('B'.repeat(MAX_BACKGROUND_CHARS));
  });
  it('keeps both materials complete when their combined size fits the budget', () => {
    const resume = 'R'.repeat(5288);
    const jd = 'J'.repeat(379);
    const prefix = buildStablePrefix(resume, jd, 'chinese');
    expect(prefix).toContain(resume);
    expect(prefix).toContain(jd);
  });
  it('shares unused space while bounding oversized materials in either slot', () => {
    for (const [r, j, keptR, keptJ] of [[7000, 2000, 6000, 2000], [1000, 9000, 1000, 7000], [9000, 9000, 5000, 3000]]) {
      const prefix = buildStablePrefix('R'.repeat(r), 'J'.repeat(j), 'chinese');
      expect(prefix).toContain('R'.repeat(keptR));
      expect(prefix).not.toContain('R'.repeat(keptR + 1));
      expect(prefix).toContain('J'.repeat(keptJ));
      expect(prefix).not.toContain('J'.repeat(keptJ + 1));
    }
  });
});

describe('smartClip (priority-aware budget truncation)', () => {
  it('returns text unchanged when under budget', () => {
    expect(smartClip('短文本', 100, RESUME_PRIORITY)).toBe('短文本');
  });
  it('keeps priority paragraphs (project experience / JD requirements) over filler', () => {
    const filler = '自我评价：热爱学习。'.repeat(30); // ~300 chars, no keyword
    const proj = '项目经历：做了实时转录系统，负责 ASR 链路。';
    const text = `${filler}\n\n${proj}\n\n${filler}`;
    const out = smartClip(text, proj.length + 10, JD_PRIORITY.test(proj) ? JD_PRIORITY : RESUME_PRIORITY);
    expect(out).toContain('项目经历');
    expect(out.length).toBeLessThanOrEqual(proj.length + 10);
  });
  it('hard-slices a single oversized paragraph', () => {
    expect(smartClip('A'.repeat(500), 100, RESUME_PRIORITY)).toHaveLength(100);
  });
});

describe('classifyQuestion + questionHint', () => {
  it('classifies behavioral questions', () => {
    expect(classifyQuestion('先做个自我介绍吧')).toBe('behavioral');
    expect(classifyQuestion('你为什么从上一家公司离职？')).toBe('behavioral');
    expect(classifyQuestion('说说你印象最深的一个项目挑战')).toBe('behavioral');
    expect(classifyQuestion('Tell me about yourself')).toBe('behavioral');
  });
  it('classifies technical questions', () => {
    expect(classifyQuestion('讲讲 Redis 的持久化原理')).toBe('technical');
    expect(classifyQuestion('这个查询怎么优化性能？')).toBe('technical');
    expect(classifyQuestion('手写一个二叉树的层序遍历')).toBe('technical');
    expect(classifyQuestion('What is the difference between TCP and UDP?')).toBe('technical');
  });
  it('classifies smalltalk', () => {
    expect(classifyQuestion('你好，能听到我说话吗？')).toBe('smalltalk');
    expect(classifyQuestion('Hi, can you hear me?')).toBe('smalltalk');
  });
  it('falls back to other (no hint) when unsure', () => {
    expect(classifyQuestion('今天我们随便聊聊')).toBe('other');
    expect(questionHint('other')).toBe('');
  });
  it('appends the hint line to the user message', () => {
    const msgs = buildAnswerMessages({
      mode: 'segment',
      question: '讲讲 Redis 的持久化原理',
      recentTranscript: [],
    });
    expect(msgs[msgs.length - 1].content).toContain('题型：技术题');
  });
});

describe('buildMemoUpdateMessages / clampMemo (P1-5 pure logic)', () => {
  it('folds the old memo and the new Q&A into a bounded structured prompt', () => {
    const msgs = buildMemoUpdateMessages('【已问问题】自我介绍', '你的优势是什么？', '我的优势是后端高并发。');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toContain('800 字');
    expect(msgs[0].content).toContain('不是候选人实际发言');
    expect(msgs[1].content).toContain('【已问问题】自我介绍');
    expect(msgs[1].content).toContain('问：你的优势是什么？');
    expect(msgs[1].content).toContain('AI 建议（未实际说出）：我的优势是后端高并发。');
  });
  it('shows （空） for a first-time memo', () => {
    const msgs = buildMemoUpdateMessages('', 'q', 'a');
    expect(msgs[1].content).toContain('（空）');
  });
  it('clampMemo hard-caps the stored memo', () => {
    expect(clampMemo('x'.repeat(5000))).toHaveLength(MAX_MEMO_CHARS);
    expect(clampMemo('  ok  ')).toBe('ok');
  });
});

describe('buildPrewarmMessages (P1-6 prefix-cache warm)', () => {
  it('system message is byte-identical to real answer requests', () => {
    const prefix = buildStablePrefix('简历', 'JD', 'chinese');
    const warm = buildPrewarmMessages(prefix);
    const real = buildAnswerMessages({
      mode: 'segment',
      question: 'q',
      recentTranscript: [],
      resume: '简历',
      jd: 'JD',
    });
    expect(warm[0].role).toBe('system');
    expect(warm[0].content).toBe(real[0].content);
    // the user turn is tiny and CONSTANT (no timestamps → deterministic)
    expect(warm[1]).toEqual({ role: 'user', content: 'ok' });
  });
});

describe('memo block (rolling interview memo, P1)', () => {
  it('sits between the stable prefix and the history', () => {
    const history: ChatMessage[] = [{ role: 'user', content: '旧问题' }];
    const msgs = buildAnswerMessages({
      mode: 'segment',
      question: '新问题',
      recentTranscript: [],
      memo: '已问：自我介绍。我已声称：三年经验。',
      history,
    });
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].content).toContain('【面试进行备忘】');
    expect(msgs[1].content).toContain('三年经验');
    expect(msgs[3].content).toContain('此前问题／手动输入：旧问题');
  });
  it('is omitted entirely when empty', () => {
    const msgs = buildAnswerMessages({ mode: 'segment', question: 'q', recentTranscript: [], memo: ' ' });
    expect(JSON.stringify(msgs)).not.toContain('面试进行备忘');
  });
});

describe('extractMessageText (non-stream reply)', () => {
  it('pulls choices[0].message.content', () => {
    expect(extractMessageText('{"choices":[{"message":{"content":"你好"}}]}')).toBe('你好');
    expect(extractMessageText('bad json')).toBe('');
    expect(extractMessageText('{"choices":[]}')).toBe('');
  });
});

describe('toProxyRules', () => {
  it('formats bare host:port for both schemes', () => {
    expect(toProxyRules('127.0.0.1:7897')).toBe('http=127.0.0.1:7897;https=127.0.0.1:7897');
    expect(toProxyRules('http://127.0.0.1:7897')).toBe('http=127.0.0.1:7897;https=127.0.0.1:7897');
    expect(toProxyRules('')).toBe('');
    expect(toProxyRules(undefined)).toBe('');
  });
});

describe('langDirective', () => {
  it('produces a distinct hook per language', () => {
    expect(langDirective('chinese')).toContain('中文');
    expect(langDirective('english')).toContain('英文');
    expect(langDirective('chinese')).not.toBe(langDirective('english'));
  });
});

describe('buildTranslateMessages / translate mode', () => {
  it('targets Chinese, output-only, no context', () => {
    const msgs = buildTranslateMessages('Could you introduce your company?');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toContain('简体中文');
    expect(msgs[0].content).toContain('只输出译文');
    expect(msgs[1].content).toBe('Could you introduce your company?');
  });

  it('translate mode routes through buildAnswerMessages ignoring answerLang', () => {
    const msgs = buildAnswerMessages({
      mode: 'translate',
      question: 'Hello world',
      recentTranscript: ['irrelevant context'],
      answerLang: 'english',
    });
    // no transcript context leaks into a translation request
    expect(JSON.stringify(msgs)).not.toContain('irrelevant context');
    expect(msgs[1].content).toBe('Hello world');
    expect(msgs[0].content).toContain('简体中文');
  });
});

describe('buildVisionMessages', () => {
  it('grounds code review in visible lines and requests a crop for ambiguous indentation', () => {
    const prompt = buildVisionMessages('', 'data:image/png;base64,AAA')[0].content;
    expect(prompt).toContain('可辨认的代码行');
    expect(prompt).toContain('缩进');
    expect(prompt).toContain('放大或裁剪');
    expect(buildVisionMessages('', 'img', undefined, 'written')[0].content).not.toContain('可辨认的代码行');
  });
  it('checks Python block headers against their bodies before tracing an early return', () => {
    const [system] = buildVisionMessages('调用 login_greeting("fr") 实际输出什么？请根据截图中的缩进解释。', 'img');
    expect(system.content).toMatch(/左对齐.*缩进更深.*再.*控制流/u);
    expect(system.content).toContain('与块头左对齐的语句不属于该块的主体');
    expect(system.content).toContain('无需估算空格数');
  });
  it.each(['english', 'chinese'] as const)('uses the selected %s interview screenshot language', (lang) => {
    const msgs = buildVisionMessages('Explain this diagram', 'data:image/png;base64,AAA', undefined, 'interview', lang);
    expect(msgs[0].content).toContain(lang === 'english' ? '用【英文】输出' : '用【中文】输出');
    expect(msgs[0].content).not.toContain(lang === 'english' ? '用【中文】输出' : '用【英文】输出');
  });

  it('keeps old screenshot calls in Chinese and written screenshots independent of interview language', () => {
    expect(buildVisionMessages('', 'data:image/png;base64,AAA')[0].content).toContain('用【中文】输出');
    const written = buildVisionMessages('', 'data:image/png;base64,AAA', undefined, 'written', 'english');
    expect(written[0].content).toContain('用中文输出');
    expect(written[0].content).not.toContain('用【英文】输出');
  });

  it('builds one multimodal user message: image first, question second', () => {
    const msgs = buildVisionMessages('这页 PPT 讲什么？', 'data:image/png;base64,AAA');
    expect(msgs).toHaveLength(2);
    const content = msgs[1].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } });
    expect(content[1]).toEqual({ type: 'text', text: '这页 PPT 讲什么？' });
  });

  it('uses interview style and a read-aloud default question in interviews', () => {
    const msgs = buildVisionMessages('  ', 'data:image/png;base64,AAA');
    const content = msgs[1].content as Array<{ type: string; text?: string }>;
    expect(content[1].text).toContain('面试');
    expect(content[1].text).toContain('照着念');
    expect(msgs[0].content).toContain('STAR');
    expect(msgs[0].content).toContain('复杂度');
    expect(msgs[0].content).not.toContain('通常不超过三句');
  });

  it('keeps concise final answers and numbered questions in written tests', () => {
    const msgs = buildVisionMessages('', 'data:image/png;base64,AAA', undefined, 'written');
    const content = msgs[1].content as Array<{ type: string; text?: string }>;
    expect(content[1].text).toContain('按题号逐行输出');
    expect(msgs[0].content).toContain('只输出最终答案');
    expect(msgs[0].content).toContain('通常不超过三句');
    expect(msgs[0].content).not.toContain('STAR');
    expect(msgs[0].content).not.toContain('面试提词器');
  });

  it('keeps workspace styles separate across consecutive screenshot requests', () => {
    const before = buildVisionMessages('介绍我的项目', 'data:image/png;base64,AAA', '真实经历', 'interview');
    buildVisionMessages('选哪个？', 'data:image/png;base64,BBB', undefined, 'written');
    expect(buildVisionMessages('介绍我的项目', 'data:image/png;base64,AAA', '真实经历', 'interview')).toEqual(before);
    expect(before[0].content).toContain('真实经历');
  });
});

describe('clampTranscript', () => {
  it('keeps the newest lines within budget', () => {
    const lines = ['老'.repeat(2000), '中'.repeat(1000), '新'.repeat(1000)];
    const out = clampTranscript(lines, MAX_CONTEXT_CHARS);
    expect(out).toHaveLength(2);
    expect(out[out.length - 1][0]).toBe('新');
  });
  it('returns all lines when under budget', () => {
    expect(clampTranscript(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('chatStream (mock OpenAI-compatible server)', () => {
  let server: Server;
  let baseUrl: string;
  let lastReq: { url?: string; auth?: string; body?: any } = {};
  let behavior: 'stream' | 'error401' | 'slow' | 'json' = 'stream';

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        lastReq = { url: req.url, auth: req.headers.authorization, body: JSON.parse(raw || '{}') };
        if (behavior === 'error401') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end('{"error":{"message":"bad key"}}');
          return;
        }
        if (behavior === 'json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: '好' } }],
              usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 },
            }),
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunks = [
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"建议"}}]}\n\ndata: {"choices":[{"delta":{"content":"这样"}}]}\n\n',
          // split one event across two TCP writes
          'data: {"choices":[{"delta":{"content":"回',
          '答"}}]}\n\n',
          'data: [DONE]\n\n',
        ];
        if (behavior === 'slow') {
          let i = 0;
          const timer = setInterval(() => {
            if (i < chunks.length) res.write(chunks[i++]);
            else {
              clearInterval(timer);
              res.end();
            }
          }, 40);
          req.on('close', () => clearInterval(timer));
        } else {
          for (const c of chunks) res.write(c);
          res.end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}/v1`;
  });

  afterAll(() => {
    server.close();
  });

  const cfg = () => ({ baseUrl, model: 'deepseek-v4-flash', apiKey: 'sk-test' });
  const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];

  it('sends the right request shape and assembles streamed deltas', async () => {
    behavior = 'stream';
    const deltas: string[] = [];
    const r = await chatStream(cfg(), msgs, { onDelta: (d) => deltas.push(d) });
    expect(r.text).toBe('建议这样回答');
    expect(deltas.join('')).toBe('建议这样回答');
    expect(lastReq.url).toBe('/v1/chat/completions');
    expect(lastReq.auth).toBe('Bearer sk-test');
    expect(lastReq.body.model).toBe('deepseek-v4-flash');
    expect(lastReq.body.stream).toBe(true);
    expect(lastReq.body.messages).toEqual(msgs);
  });

  it('passes multimodal content through unchanged (vision payloads)', async () => {
    behavior = 'stream';
    const vmsgs = buildVisionMessages('看图', 'data:image/png;base64,BBB');
    await chatStream(cfg(), vmsgs, { onDelta: () => {} });
    expect(lastReq.body.messages).toEqual(JSON.parse(JSON.stringify(vmsgs)));
  });

  it('throws a useful error on HTTP failure', async () => {
    behavior = 'error401';
    await expect(chatStream(cfg(), msgs, { onDelta: () => {} })).rejects.toThrow(/401/);
  });

  it('chatOnce: non-streaming, max_tokens for prewarm, returns cache usage', async () => {
    behavior = 'json';
    const r = await chatOnce(cfg(), buildPrewarmMessages('前缀'), { maxTokens: 1 });
    expect(r.text).toBe('好');
    expect(r.usage?.prompt_cache_hit_tokens).toBe(64);
    expect(r.usage?.prompt_cache_miss_tokens).toBe(36);
    expect(lastReq.body.stream).toBe(false);
    expect(lastReq.body.max_tokens).toBe(1);
    expect(lastReq.body.messages[0].content).toBe('前缀');
  });

  it('chatOnce: omits max_tokens by default and honors temperature (memo path)', async () => {
    behavior = 'json';
    await chatOnce(cfg(), [{ role: 'user', content: 'x' }], { temperature: 0.2 });
    expect(lastReq.body.max_tokens).toBeUndefined();
    expect(lastReq.body.temperature).toBe(0.2);
  });

  it('supports aborting mid-stream', async () => {
    behavior = 'slow';
    const ac = new AbortController();
    const deltas: string[] = [];
    const p = chatStream(cfg(), msgs, { onDelta: (d) => deltas.push(d) }, ac.signal);
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toThrow();
    expect(deltas.join('').length).toBeLessThan('建议这样回答'.length);
  });
});

it('includes relevant shared technical knowledge alongside only the supplied role', () => {
 const messages = buildAnswerMessages({mode:'continuous', question:'How does hybrid search work?', jd:'Search platform role', recentTranscript:[]});
 expect(messages[0].content).toContain('Search platform role');
 expect(messages.at(-1)?.content).toContain('RRF');
 expect(JSON.stringify(messages)).not.toContain('幂等键');
 expect(JSON.stringify(buildAnswerMessages({mode:'translate',question:'hybrid search',recentTranscript:[]}))).not.toContain('RRF');
});

it('uses the supplied JD to select technical references for role-fit questions and uses prior questions for short follow-ups', () => {
 const fit = buildAnswerMessages({mode:'continuous', question:'Why this role?', jd:'Implement hybrid search', recentTranscript:[]});
 expect(fit.at(-1)?.content).toContain('RRF');
 const follow = buildAnswerMessages({mode:'continuous', question:'Why?', recentTranscript:[],history:[{role:'user',content:'How does SQL indexing work?'}]});
 expect(follow.at(-1)?.content).toContain('执行计划');
});
