// ============================================
// Dictaloom - Dictation Styles & App Mappings
// ============================================

// Simple Icons CDN base URL
const SI_CDN = 'https://cdn.simpleicons.org';

// ============================================
// Built-in Dictation Styles
// ============================================
const BUILT_IN_STYLES = [
  {
    id: 'normal',
    name: 'Normal',
    icon: '🗣️',
    color: '#A1A1AA',
    description: 'Faithful to your voice — direct quote with minimal cleanup',
    prompt: 'Transcribe this dictation faithfully as a direct quote. Only add proper punctuation and capitalization. Do NOT rephrase, reorder, paraphrase, or change the wording in any way. Keep every word the speaker said. Remove only obvious filler words like "um", "uh", "like" (when used as filler). The output must read as if the speaker typed it themselves, word for word.'
  },
  {
    id: 'native',
    name: 'Native Language',
    icon: '🌍',
    color: '#06B6D4',
    description: 'Speak in your native language — get English text',
    language: 'fa', // Default to Persian/Farsi; user can change in settings
    prompt: 'You are a translation assistant. The user spoke in their native language. Translate their speech into natural, fluent English. Preserve the full meaning — do NOT drop any ideas, do NOT summarize, do NOT skip anything. The output must be entirely in English. If the speaker used English words or phrases mixed in, keep those as-is. Make the English output read naturally, as if the speaker had originally spoken in English.',
    languageOptions: [
      { code: 'fa', name: 'فارسی (Persian)' },
      { code: 'ar', name: 'العربية (Arabic)' },
      { code: 'tr', name: 'Türkçe (Turkish)' },
      { code: 'hi', name: 'हिन्दी (Hindi)' },
      { code: 'ur', name: 'اردو (Urdu)' },
      { code: 'zh', name: '中文 (Chinese)' },
      { code: 'ja', name: '日本語 (Japanese)' },
      { code: 'ko', name: '한국어 (Korean)' },
      { code: 'ru', name: 'Русский (Russian)' },
      { code: 'de', name: 'Deutsch (German)' },
      { code: 'fr', name: 'Français (French)' },
      { code: 'es', name: 'Español (Spanish)' },
      { code: 'pt', name: 'Português (Portuguese)' },
      { code: 'it', name: 'Italiano (Italian)' },
      { code: 'nl', name: 'Nederlands (Dutch)' },
      { code: 'pl', name: 'Polski (Polish)' },
      { code: 'uk', name: 'Українська (Ukrainian)' },
      { code: 'vi', name: 'Tiếng Việt (Vietnamese)' },
      { code: 'th', name: 'ไทย (Thai)' },
      { code: 'id', name: 'Bahasa Indonesia' },
      { code: 'ms', name: 'Bahasa Melayu (Malay)' },
      { code: 'bn', name: 'বাংলা (Bengali)' },
      { code: 'ta', name: 'தமிழ் (Tamil)' },
      { code: 'he', name: 'עברית (Hebrew)' },
      { code: 'el', name: 'Ελληνικά (Greek)' },
      { code: 'sv', name: 'Svenska (Swedish)' },
      { code: 'da', name: 'Dansk (Danish)' },
      { code: 'fi', name: 'Suomi (Finnish)' },
      { code: 'no', name: 'Norsk (Norwegian)' },
      { code: 'ro', name: 'Română (Romanian)' },
      { code: 'cs', name: 'Čeština (Czech)' },
      { code: 'hu', name: 'Magyar (Hungarian)' },
      { code: 'sw', name: 'Kiswahili (Swahili)' },
      { code: 'tl', name: 'Tagalog (Filipino)' }
    ]
  },
  {
    id: 'casual',
    name: 'Casual Chat',
    icon: '💬',
    color: '#00d4aa',
    description: 'Relaxed messaging tone',
    prompt: 'Format this dictation for casual messaging. Use lowercase when natural, minimal punctuation, contractions, and relaxed grammar. Keep it conversational and brief. Remove filler words. Do not add greetings or sign-offs unless dictated.'
  },
  {
    id: 'email',
    name: 'Professional Email',
    icon: '📧',
    color: '#7C5CFC',
    description: 'Polished work emails',
    prompt: 'Format this dictation as a professional email. Use proper capitalization, full sentences, and a formal but warm tone. Organize into clear paragraphs. Add appropriate punctuation. Remove filler words and false starts. Preserve the original meaning exactly.'
  },
  {
    id: 'academic',
    name: 'Academic Writing',
    icon: '🎓',
    color: '#3B82F6',
    description: 'Papers, essays, research',
    prompt: 'Format this dictation for academic writing. Use formal, precise language with no contractions. Employ complex sentence structures where appropriate. Maintain scholarly tone. Remove all filler words. Ensure proper punctuation and grammar.'
  },
  {
    id: 'technical',
    name: 'Technical / Code',
    icon: '⌨️',
    color: '#F59E0B',
    description: 'Code comments, docs, specs',
    prompt: 'Format this dictation for technical documentation. Be concise and precise. Preserve all technical terminology exactly. Use proper formatting for code references. Remove filler words. Use active voice. Keep sentences short and clear.'
  },
  {
    id: 'creative',
    name: 'Creative Writing',
    icon: '✍️',
    color: '#EC4899',
    description: 'Stories, blogs, articles',
    prompt: 'Format this dictation for creative writing. Use expressive, vivid language. Vary sentence length and structure for rhythm. Preserve the speaker\'s unique voice and style. Add appropriate punctuation for emphasis. Remove only obvious filler words.'
  },
  {
    id: 'notes',
    name: 'Meeting Notes',
    icon: '📋',
    color: '#10B981',
    description: 'Quick structured notes',
    prompt: 'Format this dictation as meeting notes. Convert to concise bullet points. Identify action items and decisions. Use short phrases rather than full sentences. Remove all filler words. Organize by topic if multiple subjects are discussed.'
  },
  {
    id: 'social',
    name: 'Social Media',
    icon: '📱',
    color: '#8B5CF6',
    description: 'Twitter, LinkedIn, posts',
    prompt: 'Format this dictation for social media. Make it punchy and engaging. Use short sentences. Add appropriate emoji if natural. Keep it concise. Remove filler words. Make it shareable and attention-grabbing while preserving the original message.'
  },
  {
    id: 'medical',
    name: 'Medical / Legal',
    icon: '⚕️',
    color: '#EF4444',
    description: 'Precise terminology',
    prompt: 'Format this dictation for medical or legal documentation. Preserve all terminology exactly as spoken. Use formal, precise language. Do not simplify or paraphrase technical terms. Ensure proper punctuation. Remove filler words but keep all substantive content.'
  },
  {
    id: 'bullets',
    name: 'Bullet Points',
    icon: '📌',
    color: '#F97316',
    description: 'Lists and outlines',
    prompt: 'Convert this dictation into clean bullet points. Each point should be concise. Use sub-bullets for related details. Remove all filler words. Organize logically. Do not use full sentences unless necessary for clarity.'
  },
  {
    id: 'verbatim',
    name: 'Verbatim',
    icon: '📝',
    color: '#6B7280',
    description: 'Exact transcription, no cleanup',
    prompt: null // null = skip AI formatting, use raw transcription
  }
];

// ============================================
// App-to-Style Mapping (200+ apps)
// Key: process name (lowercase), Value: { styleId, name, icon (SI slug) }
// Icons from https://cdn.simpleicons.org/{slug}/{color}
// ============================================
const APP_STYLE_MAP = {
  // --- Messaging (casual) ---
  telegram: { styleId: 'casual', name: 'Telegram', icon: 'telegram' },
  whatsapp: { styleId: 'casual', name: 'WhatsApp', icon: 'whatsapp' },
  discord: { styleId: 'casual', name: 'Discord', icon: 'discord' },
  slack: { styleId: 'casual', name: 'Slack', icon: 'slack' },
  signal: { styleId: 'casual', name: 'Signal', icon: 'signal' },
  messenger: { styleId: 'casual', name: 'Messenger', icon: 'messenger' },
  wechat: { styleId: 'casual', name: 'WeChat', icon: 'wechat' },
  line: { styleId: 'casual', name: 'LINE', icon: 'line' },
  viber: { styleId: 'casual', name: 'Viber', icon: 'viber' },
  skype: { styleId: 'casual', name: 'Skype', icon: 'skype' },
  element: { styleId: 'casual', name: 'Element', icon: 'element' },
  guilded: { styleId: 'casual', name: 'Guilded', icon: 'guilded' },
  revolt: { styleId: 'casual', name: 'Revolt', icon: 'revoltdotchat' },
  session: { styleId: 'casual', name: 'Session', icon: 'session' },
  wire: { styleId: 'casual', name: 'Wire', icon: 'wire' },
  zulip: { styleId: 'casual', name: 'Zulip', icon: 'zulip' },
  mattermost: { styleId: 'casual', name: 'Mattermost', icon: 'mattermost' },
  rocketchat: { styleId: 'casual', name: 'Rocket.Chat', icon: 'rocketdotchat' },
  kakaotalk: { styleId: 'casual', name: 'KakaoTalk', icon: 'kakaotalk' },
  snapchat: { styleId: 'casual', name: 'Snapchat', icon: 'snapchat' },
  icq: { styleId: 'casual', name: 'ICQ', icon: 'icq' },
  franz: { styleId: 'casual', name: 'Franz', icon: 'franz' },
  rambox: { styleId: 'casual', name: 'Rambox', icon: 'rambox' },
  beeper: { styleId: 'casual', name: 'Beeper', icon: 'beeper' },
  pidgin: { styleId: 'casual', name: 'Pidgin', icon: 'pidgin' },

  // --- Email (professional) ---
  outlook: { styleId: 'email', name: 'Outlook', icon: 'microsoftoutlook' },
  thunderbird: { styleId: 'email', name: 'Thunderbird', icon: 'thunderbird' },
  mailspring: { styleId: 'email', name: 'Mailspring', icon: 'mailspring' },
  emclient: { styleId: 'email', name: 'eM Client', icon: 'emclient' },
  postbox: { styleId: 'email', name: 'Postbox', icon: 'postbox' },
  spark: { styleId: 'email', name: 'Spark', icon: 'spark' },
  bluemail: { styleId: 'email', name: 'BlueMail', icon: 'bluemail' },
  protonmail: { styleId: 'email', name: 'Proton Mail', icon: 'protonmail' },
  tutanota: { styleId: 'email', name: 'Tuta', icon: 'tuta' },
  canary: { styleId: 'email', name: 'Canary Mail', icon: 'canarymail' },

  // --- Code Editors (technical) ---
  code: { styleId: 'technical', name: 'VS Code', icon: 'visualstudiocode' },
  'code - insiders': { styleId: 'technical', name: 'VS Code Insiders', icon: 'visualstudiocode' },
  cursor: { styleId: 'technical', name: 'Cursor', icon: 'cursor' },
  windsurf: { styleId: 'technical', name: 'Windsurf', icon: 'codeium' },
  devenv: { styleId: 'technical', name: 'Visual Studio', icon: 'visualstudio' },
  idea64: { styleId: 'technical', name: 'IntelliJ IDEA', icon: 'intellijidea' },
  pycharm64: { styleId: 'technical', name: 'PyCharm', icon: 'pycharm' },
  webstorm64: { styleId: 'technical', name: 'WebStorm', icon: 'webstorm' },
  phpstorm64: { styleId: 'technical', name: 'PhpStorm', icon: 'phpstorm' },
  rider64: { styleId: 'technical', name: 'Rider', icon: 'rider' },
  goland64: { styleId: 'technical', name: 'GoLand', icon: 'goland' },
  clion64: { styleId: 'technical', name: 'CLion', icon: 'clion' },
  rubymine64: { styleId: 'technical', name: 'RubyMine', icon: 'rubymine' },
  datagrip64: { styleId: 'technical', name: 'DataGrip', icon: 'datagrip' },
  'android studio': { styleId: 'technical', name: 'Android Studio', icon: 'androidstudio' },
  sublime_text: { styleId: 'technical', name: 'Sublime Text', icon: 'sublimetext' },
  notepad: { styleId: 'technical', name: 'Notepad', icon: 'notepadplusplus' },
  'notepad++': { styleId: 'technical', name: 'Notepad++', icon: 'notepadplusplus' },
  atom: { styleId: 'technical', name: 'Atom', icon: 'atom' },
  emacs: { styleId: 'technical', name: 'Emacs', icon: 'gnuemacs' },
  vim: { styleId: 'technical', name: 'Vim', icon: 'vim' },
  nvim: { styleId: 'technical', name: 'Neovim', icon: 'neovim' },
  'nova': { styleId: 'technical', name: 'Nova', icon: 'nova' },
  zed: { styleId: 'technical', name: 'Zed', icon: 'zedindustries' },
  fleet: { styleId: 'technical', name: 'Fleet', icon: 'jetbrains' },
  lapce: { styleId: 'technical', name: 'Lapce', icon: 'lapce' },
  helix: { styleId: 'technical', name: 'Helix', icon: 'helix' },

  // --- Browsers (casual default) ---
  chrome: { styleId: 'casual', name: 'Google Chrome', icon: 'googlechrome' },
  firefox: { styleId: 'casual', name: 'Firefox', icon: 'firefox' },
  msedge: { styleId: 'casual', name: 'Microsoft Edge', icon: 'microsoftedge' },
  brave: { styleId: 'casual', name: 'Brave', icon: 'brave' },
  opera: { styleId: 'casual', name: 'Opera', icon: 'opera' },
  vivaldi: { styleId: 'casual', name: 'Vivaldi', icon: 'vivaldi' },
  arc: { styleId: 'casual', name: 'Arc', icon: 'arc' },
  safari: { styleId: 'casual', name: 'Safari', icon: 'safari' },
  tor: { styleId: 'casual', name: 'Tor Browser', icon: 'torbrowser' },
  waterfox: { styleId: 'casual', name: 'Waterfox', icon: 'waterfox' },
  floorp: { styleId: 'casual', name: 'Floorp', icon: 'floorp' },
  librewolf: { styleId: 'casual', name: 'LibreWolf', icon: 'librewolf' },
  chromium: { styleId: 'casual', name: 'Chromium', icon: 'chromium' },
  'google-chrome': { styleId: 'casual', name: 'Chrome', icon: 'googlechrome' },
  zen: { styleId: 'casual', name: 'Zen Browser', icon: 'zenbrowser' },

  // --- Office / Docs (professional) ---
  winword: { styleId: 'email', name: 'Microsoft Word', icon: 'microsoftword' },
  excel: { styleId: 'verbatim', name: 'Microsoft Excel', icon: 'microsoftexcel' },
  powerpnt: { styleId: 'email', name: 'PowerPoint', icon: 'microsoftpowerpoint' },
  onenote: { styleId: 'notes', name: 'OneNote', icon: 'microsoftonenote' },
  swriter: { styleId: 'email', name: 'LibreOffice Writer', icon: 'libreoffice' },
  scalc: { styleId: 'verbatim', name: 'LibreOffice Calc', icon: 'libreoffice' },
  simpress: { styleId: 'email', name: 'LibreOffice Impress', icon: 'libreoffice' },
  'google docs': { styleId: 'email', name: 'Google Docs', icon: 'googledocs' },
  'google sheets': { styleId: 'verbatim', name: 'Google Sheets', icon: 'googlesheets' },
  'google slides': { styleId: 'email', name: 'Google Slides', icon: 'googleslides' },
  wps: { styleId: 'email', name: 'WPS Office', icon: 'wps' },
  pages: { styleId: 'email', name: 'Pages', icon: 'apple' },
  numbers: { styleId: 'verbatim', name: 'Numbers', icon: 'apple' },
  keynote: { styleId: 'email', name: 'Keynote', icon: 'apple' },

  // --- Note-Taking (bullets) ---
  notion: { styleId: 'bullets', name: 'Notion', icon: 'notion' },
  obsidian: { styleId: 'bullets', name: 'Obsidian', icon: 'obsidian' },
  evernote: { styleId: 'bullets', name: 'Evernote', icon: 'evernote' },
  joplin: { styleId: 'bullets', name: 'Joplin', icon: 'joplin' },
  logseq: { styleId: 'bullets', name: 'Logseq', icon: 'logseq' },
  standardnotes: { styleId: 'bullets', name: 'Standard Notes', icon: 'standardnotes' },
  bear: { styleId: 'bullets', name: 'Bear', icon: 'bear' },
  roamresearch: { styleId: 'bullets', name: 'Roam', icon: 'roamresearch' },
  craft: { styleId: 'bullets', name: 'Craft', icon: 'craft' },
  anytype: { styleId: 'bullets', name: 'Anytype', icon: 'anytype' },
  coda: { styleId: 'bullets', name: 'Coda', icon: 'coda' },
  remnote: { styleId: 'bullets', name: 'RemNote', icon: 'remnote' },
  capacities: { styleId: 'bullets', name: 'Capacities', icon: 'capacities' },

  // --- Social Media (social) ---
  twitter: { styleId: 'social', name: 'X / Twitter', icon: 'x' },
  instagram: { styleId: 'social', name: 'Instagram', icon: 'instagram' },
  tiktok: { styleId: 'social', name: 'TikTok', icon: 'tiktok' },
  reddit: { styleId: 'social', name: 'Reddit', icon: 'reddit' },
  linkedin: { styleId: 'social', name: 'LinkedIn', icon: 'linkedin' },
  facebook: { styleId: 'social', name: 'Facebook', icon: 'facebook' },
  threads: { styleId: 'social', name: 'Threads', icon: 'threads' },
  mastodon: { styleId: 'social', name: 'Mastodon', icon: 'mastodon' },
  bluesky: { styleId: 'social', name: 'Bluesky', icon: 'bluesky' },
  tumblr: { styleId: 'social', name: 'Tumblr', icon: 'tumblr' },
  pinterest: { styleId: 'social', name: 'Pinterest', icon: 'pinterest' },
  quora: { styleId: 'social', name: 'Quora', icon: 'quora' },
  medium: { styleId: 'social', name: 'Medium', icon: 'medium' },
  substack: { styleId: 'social', name: 'Substack', icon: 'substack' },
  devto: { styleId: 'social', name: 'DEV', icon: 'devdotto' },
  hackernews: { styleId: 'social', name: 'Hacker News', icon: 'ycombinator' },

  // --- Meetings (notes) ---
  zoom: { styleId: 'notes', name: 'Zoom', icon: 'zoom' },
  teams: { styleId: 'notes', name: 'Microsoft Teams', icon: 'microsoftteams' },
  webex: { styleId: 'notes', name: 'Webex', icon: 'webex' },
  'google meet': { styleId: 'notes', name: 'Google Meet', icon: 'googlemeet' },
  obs64: { styleId: 'notes', name: 'OBS Studio', icon: 'obsstudio' },
  loom: { styleId: 'notes', name: 'Loom', icon: 'loom' },
  around: { styleId: 'notes', name: 'Around', icon: 'around' },
  whereby: { styleId: 'notes', name: 'Whereby', icon: 'whereby' },
  streamyard: { styleId: 'notes', name: 'StreamYard', icon: 'streamyard' },

  // --- Terminals (technical) ---
  windowsterminal: { styleId: 'technical', name: 'Windows Terminal', icon: 'windowsterminal' },
  wt: { styleId: 'technical', name: 'Windows Terminal', icon: 'windowsterminal' },
  powershell: { styleId: 'technical', name: 'PowerShell', icon: 'powershell' },
  pwsh: { styleId: 'technical', name: 'PowerShell', icon: 'powershell' },
  cmd: { styleId: 'technical', name: 'Command Prompt', icon: 'windowsterminal' },
  'git-bash': { styleId: 'technical', name: 'Git Bash', icon: 'git' },
  hyper: { styleId: 'technical', name: 'Hyper', icon: 'hyper' },
  alacritty: { styleId: 'technical', name: 'Alacritty', icon: 'alacritty' },
  wezterm: { styleId: 'technical', name: 'WezTerm', icon: 'wezterm' },
  iterm2: { styleId: 'technical', name: 'iTerm2', icon: 'iterm2' },
  tabby: { styleId: 'technical', name: 'Tabby', icon: 'tabby' },
  kitty: { styleId: 'technical', name: 'Kitty', icon: 'kitty' },
  mintty: { styleId: 'technical', name: 'MinTTY', icon: 'git' },
  terminus: { styleId: 'technical', name: 'Terminus', icon: 'tabby' },
  conemu64: { styleId: 'technical', name: 'ConEmu', icon: 'windowsterminal' },

  // --- Design (bullets) ---
  figma: { styleId: 'bullets', name: 'Figma', icon: 'figma' },
  photoshop: { styleId: 'bullets', name: 'Photoshop', icon: 'adobephotoshop' },
  illustrator: { styleId: 'bullets', name: 'Illustrator', icon: 'adobeillustrator' },
  'premiere pro': { styleId: 'bullets', name: 'Premiere Pro', icon: 'adobepremierepro' },
  'after effects': { styleId: 'bullets', name: 'After Effects', icon: 'adobeaftereffects' },
  indesign: { styleId: 'bullets', name: 'InDesign', icon: 'adobeindesign' },
  xd: { styleId: 'bullets', name: 'Adobe XD', icon: 'adobexd' },
  lightroom: { styleId: 'bullets', name: 'Lightroom', icon: 'adobelightroom' },
  blender: { styleId: 'bullets', name: 'Blender', icon: 'blender' },
  sketch: { styleId: 'bullets', name: 'Sketch', icon: 'sketch' },
  canva: { styleId: 'bullets', name: 'Canva', icon: 'canva' },
  inkscape: { styleId: 'bullets', name: 'Inkscape', icon: 'inkscape' },
  gimp: { styleId: 'bullets', name: 'GIMP', icon: 'gimp' },
  davinci: { styleId: 'bullets', name: 'DaVinci Resolve', icon: 'davinciresolve' },
  krita: { styleId: 'bullets', name: 'Krita', icon: 'krita' },
  affinity: { styleId: 'bullets', name: 'Affinity', icon: 'affinity' },
  penpot: { styleId: 'bullets', name: 'Penpot', icon: 'penpot' },

  // --- DevOps / Data (technical) ---
  docker: { styleId: 'technical', name: 'Docker', icon: 'docker' },
  postman: { styleId: 'technical', name: 'Postman', icon: 'postman' },
  insomnia: { styleId: 'technical', name: 'Insomnia', icon: 'insomnia' },
  dbeaver: { styleId: 'technical', name: 'DBeaver', icon: 'dbeaver' },
  pgadmin4: { styleId: 'technical', name: 'pgAdmin', icon: 'postgresql' },
  mongodb: { styleId: 'technical', name: 'MongoDB Compass', icon: 'mongodb' },
  github: { styleId: 'technical', name: 'GitHub Desktop', icon: 'github' },
  gitkraken: { styleId: 'technical', name: 'GitKraken', icon: 'gitkraken' },
  sourcetree: { styleId: 'technical', name: 'Sourcetree', icon: 'sourcetree' },
  filezilla: { styleId: 'technical', name: 'FileZilla', icon: 'filezilla' },
  winscp: { styleId: 'technical', name: 'WinSCP', icon: 'winscp' },
  putty: { styleId: 'technical', name: 'PuTTY', icon: 'putty' },

  // --- Creative Writing ---
  scrivener: { styleId: 'creative', name: 'Scrivener', icon: 'scrivener' },
  ulysses: { styleId: 'creative', name: 'Ulysses', icon: 'ulysses' },
  iawriter: { styleId: 'creative', name: 'iA Writer', icon: 'iawriter' },
  typora: { styleId: 'creative', name: 'Typora', icon: 'typora' },
  marktext: { styleId: 'creative', name: 'Mark Text', icon: 'marktext' },
  ghostwriter: { styleId: 'creative', name: 'ghostwriter', icon: 'kde' },
  focuswriter: { styleId: 'creative', name: 'FocusWriter', icon: 'writer' },
  hemingway: { styleId: 'creative', name: 'Hemingway', icon: 'hemingway' },

  // --- Music / Media ---
  spotify: { styleId: 'casual', name: 'Spotify', icon: 'spotify' },
  vlc: { styleId: 'casual', name: 'VLC', icon: 'vlcmediaplayer' },
  audacity: { styleId: 'technical', name: 'Audacity', icon: 'audacity' },
  ableton: { styleId: 'technical', name: 'Ableton Live', icon: 'abletonlive' },
  'fl studio': { styleId: 'technical', name: 'FL Studio', icon: 'flstudio' },

  // --- Project Management ---
  clickup: { styleId: 'bullets', name: 'ClickUp', icon: 'clickup' },
  asana: { styleId: 'bullets', name: 'Asana', icon: 'asana' },
  trello: { styleId: 'bullets', name: 'Trello', icon: 'trello' },
  jira: { styleId: 'bullets', name: 'Jira', icon: 'jira' },
  linear: { styleId: 'bullets', name: 'Linear', icon: 'linear' },
  monday: { styleId: 'bullets', name: 'Monday.com', icon: 'mondaydotcom' },
  basecamp: { styleId: 'bullets', name: 'Basecamp', icon: 'basecamp' },
  todoist: { styleId: 'bullets', name: 'Todoist', icon: 'todoist' },
  ticktick: { styleId: 'bullets', name: 'TickTick', icon: 'ticktick' },
  things: { styleId: 'bullets', name: 'Things', icon: 'things' },

  // --- AI / LLM ---
  chatgpt: { styleId: 'casual', name: 'ChatGPT', icon: 'openai' },
  claude: { styleId: 'casual', name: 'Claude', icon: 'anthropic' },
  copilot: { styleId: 'technical', name: 'Copilot', icon: 'githubcopilot' },

  // --- Gaming (casual) ---
  steam: { styleId: 'casual', name: 'Steam', icon: 'steam' },
  epicgames: { styleId: 'casual', name: 'Epic Games', icon: 'epicgames' },

  // --- System / Misc ---
  explorer: { styleId: 'casual', name: 'File Explorer', icon: 'windows' },
  systemsettings: { styleId: 'casual', name: 'Settings', icon: 'windows' },
  calculator: { styleId: 'verbatim', name: 'Calculator', icon: 'windows' },
};

// Category icons for unmapped apps
const CATEGORY_DEFAULTS = {
  messaging: 'casual',
  email: 'email',
  code: 'technical',
  browser: 'casual',
  office: 'email',
  notes: 'bullets',
  social: 'social',
  meeting: 'notes',
  terminal: 'technical',
  design: 'bullets',
  creative: 'creative',
  other: 'casual'
};

// Helper: get Simple Icons CDN URL
function getAppIconUrl(siSlug, color) {
  if (!siSlug) return null;
  const c = (color || 'ffffff').replace('#', '');
  return `${SI_CDN}/${siSlug}/${c}`;
}

// Export for use in app.js
window.BUILT_IN_STYLES = BUILT_IN_STYLES;
window.APP_STYLE_MAP = APP_STYLE_MAP;
window.getAppIconUrl = getAppIconUrl;
