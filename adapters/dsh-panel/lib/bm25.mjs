// BM25 打分核心：Intl.Segmenter 中文分词（整词）+ 全字符二元组；英文/路径保留整词。
// 2026-11-07 换掉「逐字 + 二元组」：档案级 23 题 Top1 17→20（与 BM25+语义混合持平，但零 Python、零模型）。
// 2026-11-07 增三项后处理（默认全关，实验后再定默认值）：
//   roleWeights      —— 按 doc.role（或 event_type 的斜杠前段）加权，压长助手回复
//   lengthPenalty    —— 额外长度惩罚 score *= (avgdl/dl)^p（BM25 的 b 只归一 tf）
//   dedupeThreshold  —— 结果近重复抑制：与已选结果 token Jaccard ≥ 阈值就跳过（需 keepTokens）
const SEG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;

export function tokenize(text, { unigrams = true } = {}) {
  if (!text) return [];
  const s = String(text).normalize('NFKC').toLowerCase();
  const t = [];
  if (SEG) for (const p of SEG.segment(s)) if (p.isWordLike) t.push('w:' + p.segment);
  for (const run of s.match(/[\p{L}\p{N}_]+/gu) ?? []) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length; i++) t.push('b:' + chars[i] + chars[i + 1]);
  }
  return t;
}

/** 文档角色：优先 doc.role，其次 event_type 的斜杠前段（user/message → user）。 */
export function roleOf(doc) {
  const r = doc?.role ?? doc?.event_type ?? '';
  return String(r).split('/')[0] || 'unknown';
}

/**
 * 同义词组 → token 邻接表。组内每个词分词后，任一 token 都能扩展到组内其他 token。
 * @param {string[][]} groups 例如 [['轮转','旋转','rotate','context-rotate'], ...]
 */
export function buildSynonymMap(groups) {
  const map = new Map();
  for (const group of groups ?? []) {
    const all = [...new Set((group ?? []).flatMap((term) => tokenize(term)))];
    if (all.length < 2) continue;
    for (const t of all) {
      if (!map.has(t)) map.set(t, new Set());
      for (const u of all) if (u !== t) map.get(t).add(u);
    }
  }
  return map;
}

function jaccard(a, b) {
  if (!a || !b) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (small.size + big.size - inter || 1);
}

/**
 * @param {Array<{text?:string,title?:string,date?:string,role?:string,event_type?:string}>} docs
 * @param {{unigrams?:boolean,titleBoost?:number,k1?:number,b?:number,keepTokens?:boolean}} [opts]
 */
export function buildIndex(docs, { unigrams = true, titleBoost = 2, k1 = 1.2, b = 0.75, keepTokens = false } = {}) {
  const df = new Map();
  const postings = new Map();
  const lens = new Float64Array(docs.length);
  const tokens = keepTokens ? [] : null;
  docs.forEach((d, i) => {
    const titleToks = tokenize(d.title ?? '', { unigrams });
    const bodyToks = tokenize(d.text ?? '', { unigrams });
    const tf = new Map();
    for (const t of bodyToks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of titleToks) tf.set(t, (tf.get(t) ?? 0) + titleBoost);
    lens[i] = bodyToks.length + titleToks.length * titleBoost;
    if (tokens) tokens.push(new Set([...titleToks, ...bodyToks]));
    for (const [term, n] of tf) {
      if (!postings.has(term)) postings.set(term, new Map());
      postings.get(term).set(i, n);
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  });
  const N = docs.length;
  let total = 0;
  for (const x of lens) total += x;
  const avgdl = total / Math.max(1, N) || 1;
  const idf = new Map();
  for (const [term, n] of df) idf.set(term, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  return { N, docs, postings, idf, lens, avgdl, k1, b, unigrams, titleBoost, tokens };
}

/**
 * 返回 Float64Array 打分（全量），调用方自己排序。
 * @param {{unigrams?:boolean,now?:number,decayDays?:number,roleWeights?:Record<string,number>,lengthPenalty?:number,synonyms?:Map<string,Set<string>>,synonymWeight?:number}} [opts]
 */
export function scoreAll(index, query, { unigrams = index.unigrams, now = 0, decayDays = 0, roleWeights = null, lengthPenalty = 0, synonyms = null, synonymWeight = 0.45 } = {}) {
  const toks = [...new Set(tokenize(query, { unigrams }))];
  // 同义词扩展：查不到的词补进低权重的近义词 token，原词权重保持 1。
  const terms = new Map();
  for (const t of toks) terms.set(t, 1);
  if (synonyms) {
    for (const t of toks) {
      const alts = synonyms.get(t);
      if (!alts) continue;
      for (const a of alts) if (!terms.has(a)) terms.set(a, synonymWeight);
    }
  }
  const scores = new Float64Array(index.N);
  for (const [term, qw] of terms) {
    const post = index.postings.get(term);
    if (!post) continue;
    const w = (index.idf.get(term) ?? 0) * qw;
    for (const [i, tf] of post) {
      const dl = index.lens[i] || 1;
      scores[i] += (w * (tf * (index.k1 + 1))) / (tf + index.k1 * (1 - index.b + index.b * dl / index.avgdl));
    }
  }
  for (let i = 0; i < index.N; i++) {
    if (scores[i] === 0) continue;
    if (roleWeights) scores[i] *= roleWeights[roleOf(index.docs[i])] ?? 1;
    if (lengthPenalty > 0) scores[i] *= Math.pow(index.avgdl / Math.max(1, index.lens[i]), lengthPenalty);
    if (decayDays > 0 && now) {
      const d = index.docs[i].date ? Date.parse(index.docs[i].date) : NaN;
      if (Number.isFinite(d)) scores[i] *= Math.exp((-Math.LN2 * Math.max(0, (now - d) / 86400000)) / decayDays);
    }
  }
  return scores;
}

export function search(index, query, {
  topK = 5,
  decayDays = 0,
  now = 0,
  unigrams = index.unigrams,
  roleWeights = null,
  lengthPenalty = 0,
  dedupeThreshold = 0,
  synonyms = null,
  synonymWeight = 0.45,
} = {}) {
  const scores = scoreAll(index, query, { unigrams, decayDays, now, roleWeights, lengthPenalty, synonyms, synonymWeight });
  const order = [];
  for (let i = 0; i < index.N; i++) if (scores[i] > 0) order.push(i);
  order.sort((a, b) => scores[b] - scores[a] || a - b);

  let picked = order;
  if (dedupeThreshold > 0) {
    if (!index.tokens) throw new Error('dedupeThreshold 需要 buildIndex({ keepTokens: true })');
    const selected = [];
    for (const i of order) {
      if (selected.length >= topK) break;
      if (selected.every((j) => jaccard(index.tokens[i], index.tokens[j]) < dedupeThreshold)) selected.push(i);
    }
    picked = selected;
  }
  return picked.slice(0, topK).map((i) => ({ id: index.docs[i].id, score: scores[i], doc: index.docs[i] }));
}
