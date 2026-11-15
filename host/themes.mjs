/** 纸面上的投影：色相跟着墨色走，不属于任何一套强调色，但也不该散在渲染器里。
 *  图片 / 预览手机壳 / 导出纸张三种用途各一个名字；素白主张「没有影子的纸」，只关掉图片那一道。
 */
export const SHADOW = {
  img: '0 8px 26px rgba(20,16,12,0.10)',
  phone: '0 18px 50px rgba(30,24,18,0.14)',
  sheet: '0 10px 34px rgba(20,16,12,0.10)'
};

/** 五套内置主题。颜色全部在这里，渲染器不写死任何一个色值。
 * paper=正文纸色 · wash=正文外面的页面底色（导出/打开 HTML 时用）· shellBg=预览手机壳外的灰底
 * ink/sub=主副文字 · onAccent=压在强调色上的字 · shadow=纸面投影 · accent=强调色。
 */
export const THEMES = [
  {
    id: 'zhusha',
    name: '朱砂',
    tagline: '校媒 · 活动 · 庄重',
    desc: '朱红配宣纸，适合讲座、大会、党建与校园活动通报。',
    paper: '#FBF7F2', ink: '#23201D', sub: '#7A6E64',
    accent: '#B03A2E', accentSoft: '#F6E9E4', line: '#E3D6CC', gold: '#C9A227',
    wash: '#EDEAE4', shellBg: '#EDEAE4',
    section: 'chip', radius: '4px', onAccent: '#FFFFFF', shadow: SHADOW,
    cover: { bg1: '#8E2B22', bg2: '#C0503E', ink: '#FFF8F2', sub: '#F3D9CF' }
  },
  {
    id: 'qingci',
    name: '青瓷',
    tagline: '学术 · 讲座 · 清雅',
    desc: '青绿如瓷釉，适合学术讲座、教研与人文类内容。',
    paper: '#F6F8F5', ink: '#22302B', sub: '#6D7F77',
    accent: '#3C7A63', accentSoft: '#E7F0EB', line: '#D6E2DB', gold: '#A98B52',
    wash: '#E9EFEC', shellBg: '#E9EFEC',
    section: 'bar', radius: '2px', onAccent: '#FFFFFF', shadow: SHADOW,
    cover: { bg1: '#245244', bg2: '#3C7A63', ink: '#F3F9F5', sub: '#CFE4DA' }
  },
  {
    id: 'molan',
    name: '墨蓝',
    tagline: '沉稳 · 正式 · 通稿',
    desc: '深蓝配银灰，适合正式通稿、工作部署与总结。',
    paper: '#F5F7FA', ink: '#1D2430', sub: '#6B7686',
    accent: '#2E5A88', accentSoft: '#E6EDF6', line: '#D5DEE9', gold: '#B08D57',
    wash: '#E7ECF3', shellBg: '#E7ECF3',
    section: 'ghost', radius: '3px', onAccent: '#FFFFFF', shadow: SHADOW,
    cover: { bg1: '#16283C', bg2: '#2E5A88', ink: '#F4F8FC', sub: '#C9D8E8' }
  },
  {
    id: 'yingfen',
    name: '樱粉',
    tagline: '文艺 · 招新 · 轻快',
    desc: '低饱和樱粉，适合社团招新、文艺活动与节日推送。',
    paper: '#FDF7F4', ink: '#33272A', sub: '#8A7376',
    accent: '#C0607A', accentSoft: '#FBEBEF', line: '#EEDCE1', gold: '#C9A227',
    wash: '#F7EDF0', shellBg: '#F7EDF0',
    section: 'pill', radius: '8px', onAccent: '#FFFFFF', shadow: SHADOW,
    cover: { bg1: '#B85A72', bg2: '#D98FA2', ink: '#FFF8F7', sub: '#F8E2E6' }
  },
  {
    id: 'subai',
    name: '素白',
    tagline: '极简 · 阅读 · 留白',
    desc: '近乎无色的排版，让文字本身成为主角。',
    paper: '#FFFFFF', ink: '#1A1A1A', sub: '#777777',
    accent: '#1A1A1A', accentSoft: '#F2F2F2', line: '#E5E5E5', gold: '#999999',
    wash: '#F2F2F2', shellBg: '#F2F2F2',
    section: 'rule', radius: '0px', onAccent: '#FFFFFF', shadow: { ...SHADOW, img: 'none' },
    cover: { bg1: '#222222', bg2: '#3D3D3D', ink: '#FAFAFA', sub: '#C9C9C9' }
  }
];

export function getTheme(id) {
  return THEMES.find(t => t.id === id) || THEMES[0];
}

/**
 * 按标题/副题里的词挑一套配色。宁可保守：认不出来就用朱砂（校园通稿最常见）。
 * 只做一次判断，选完写进 project.theme，之后改主题靠人点或 xiumi_set_theme。
 */
const THEME_HINTS = [
  { id: 'zhusha', words: ['辛亥', '革命', '党史', '党建', '团日', '纪念', '缅怀', '烈士', '红色', '初心', '使命', '爱国', '思政'] },
  { id: 'molan', words: ['部署', '换届', '总结', '会议', '大会', '通知', '公示', '评选', '表彰', '方案', '条例', '工作'] },
  { id: 'qingci', words: ['学术', '讲座', '研讨', '论坛', '教研', '培训', '课题', '论文', '读书', '交流'] },
  { id: 'yingfen', words: ['招新', '社团', '文艺', '晚会', '节日', '迎新', '志愿', '比赛', '运动会', '毕业', '生日', '中秋', '元旦'] }
];

export function pickThemeFor(text) {
  const s = String(text || '');
  let best = null;
  let bestScore = 0;
  for (const hint of THEME_HINTS) {
    const score = hint.words.reduce((n, w) => (s.indexOf(w) >= 0 ? n + 1 : n), 0);
    if (score > bestScore) { bestScore = score; best = hint.id; }
  }
  return best || 'zhusha';
}
