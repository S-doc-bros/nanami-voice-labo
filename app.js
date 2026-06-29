import {
  DEFAULT_MODEL,
  DEFAULT_IRODORI_DURATION_SCALE,
  FALLBACK_MODELS,
  buildSpeechPayload,
  cancelSpeakerInversionJob,
  createSpeakerInversionJob,
  deleteFinalArtifact,
  deleteReferenceVoice,
  downloadFinalArtifactCheckpoint,
  downloadReferenceVoice,
  fetchSpeakerInversionJob,
  fetchBridgeInfo,
  fetchFinalArtifacts,
  fetchReferenceVoices,
  processLabAudio,
  synthesizeSpeech,
  uploadReferenceVoice,
  voiceIdFromFilename,
} from "./lib/tts-client.js?v=20260629-final-clean1";
import {
  deleteVoiceCard,
  getAudioBlob,
  listVoiceCards,
  loadSettings,
  saveSettings,
  saveVoiceCard,
} from "./lib/voice-store.js?v=20260629-final-clean1";

const $ = (id) => document.getElementById(id);
const setOptionalDisabled = (id, disabled) => {
  const element = $(id);
  if (element) element.disabled = disabled;
};
const DEFAULT_VOICE_CAPTION = "20代前半の自然な日本語話者で、中音域のクリアな声。近い距離感で、本文の感情に合わせて自然に読み上げる。息づかいは控えめ。";
const LEGACY_DEFAULT_VOICE_CAPTIONS = new Set([
  "自然な日本語話者。近い距離感で、声色はクリア、息づかいは控えめに、本文の感情に合わせて読み上げる。",
  "自然な日本語話者。音域: 中音域。表現: 近い距離感で、本文の感情に合わせて自然に読み上げる。声はクリア、息づかいは控えめ。",
]);
const SOURCE_REQUIRED_MESSAGE = "先に基準声を生成するか、音声ファイルを読み込んでください。";
const LAB_ENGINE_PROFILE = "nanami-labo-600m-v3-voicedesign-default";
const FINAL_ARTIFACT_NOTES_KEY = "nanami-voice-labo-final-artifact-notes";
const FINAL_ARTIFACT_HIDDEN_KEY = "nanami-voice-labo-final-artifact-hidden";
const DEFAULT_FINAL_ARTIFACT_DESCRIPTION = "このラボで作成した話者埋め込み成果物です。";
const FINAL_ARTIFACT_TEST_MODEL = "irodori-nanami-final-500m";
const DEFAULT_REFERENCE_CFG_SPEAKER = 1.0;
const DEFAULT_EXPRESSION_SOURCE_MODE = "direct";
const FINAL_ARTIFACT_TEST_SETTINGS = {
  seed: "",
  speed: 1,
  pitch: 0,
  numSteps: 24,
  cfgMode: "independent",
  cfgText: 1.0,
  cfgCaption: 1.0,
  cfgSpeaker: 1.0,
  scheduleMode: "linear",
  swayCoeff: -1.0,
  durationScale: 1.0,
  trimTail: true,
};
const fields = [
  "endpoint",
  "model",
  "format",
  "apiKey",
  "voice",
  "expressionSourceMode",
  "scriptCue",
  "voiceCaption",
  "text",
  "speed",
  "pitch",
  "seed",
  "numSteps",
  "cfgMode",
  "cfgText",
  "cfgCaption",
  "cfgSpeaker",
  "schedule",
  "sway",
  "hpfHz",
  "peakTargetDb",
  "deepFilterMode",
  "gainDb",
  "lowDb",
  "midDb",
  "highDb",
  "presenceDb",
  "airDb",
  "derivedVoiceName",
];
const liveSculptFields = new Set([
  "speed",
  "pitch",
  "hpfHz",
  "peakTargetDb",
  "deepFilterMode",
  "gainDb",
  "lowDb",
  "midDb",
  "highDb",
  "presenceDb",
  "airDb",
]);

let latestAudioBlob = null;
let latestSourceAudioBlob = null;
let latestSourceAudioBuffer = null;
let latestAudioUrl = "";
let latestBaseAudioUrl = "";
let latestPreviewAudioUrl = "";
let latestCard = null;
let latestSourceKind = "";
let liveAudioContext = null;
let liveAudioSource = null;
let liveEqNodes = null;
let liveSettingsSyncFrame = 0;
let lastLiveSculptSignature = "";
let lastAppliedLiveSculptSignature = "";
let sculptRenderDirty = false;
let referenceFile = null;
let mediaRecorder = null;
let recordingChunks = [];
let bridgeRefreshTimer = 0;
let scriptLength = "short";
let activeLabTab = "seed";
let seedQuality = "standard";
let expressionQueue = [];
let activeExpressionId = "";
let expressionBatchRunning = false;
let expressionSeedBase = "";
const expressionAudioBlobs = new Map();
let generalSpeechItems = [];
let generalSpeechBatchRunning = false;
const generalSpeechAudioBlobs = new Map();
const GENERAL_SPEECH_MAX_RETRIES = 2;
const GENERAL_SPEECH_RETRY_DELAYS_MS = [900, 1800];
let finalArtifacts = [];
let activeFinalArtifactId = "";
let editingFinalArtifactId = "";
let activeSpeakerBuildJobId = "";
let speakerBuildPollTimer = 0;
let speakerBuildPollErrorCount = 0;
let activeVoicePresetGroup = "female";
const SPEAKER_BUILD_POLL_MAX_ERRORS = 5;
const SPEAKER_STANDARD_EXPOSURE_PER_CLIP = 16;
const SPEAKER_STEP_HINT_GENERAL = "一般音声を含める場合は、標準でも素材数に合わせてstepを自動で増やします。";

const VOICE_CAPTION_PRESETS = {
  female: {
    label: "女性",
    presets: [
      {
        id: "female-clear",
        label: "透明感",
        text: "20代前半の女性で、中高音域の透明感があるクリアな声。近い距離感で自然に読み上げ、息は薄く、声の輪郭は滑らかにする。",
      },
      {
        id: "female-bright",
        label: "元気",
        text: "10代後半から20代前半の女性で、高めの中音域の元気な声。少し大きめに、笑顔が伝わるようテンポよく読み上げる。",
      },
      {
        id: "female-downer",
        label: "ダウナー",
        text: "20代前半の女性で、低めの中音域の気だるい声。控えめに少し遅めで淡々と読み、眠たげでも言葉の輪郭は残す。",
      },
      {
        id: "female-gentle",
        label: "優しい案内",
        text: "20代前半の女性で、中音域の優しく安心感のある声。丁寧に案内するよう自然に読み上げ、語尾は丸く、圧を出さない。",
      },
      {
        id: "female-velvet",
        label: "艶低音",
        text: "20代後半の女性で、低音域の落ち着いた声。ゆっくり、しっとり感情を乗せて読み、息の余韻は薄く、甘さは控えめにする。",
      },
    ],
  },
  male: {
    label: "男性",
    presets: [
      {
        id: "male-jarvis",
        label: "Jarvis",
        text: "30代前半の男性で、低音域から中低音域の冷静で知的なAI秘書風の声。控えめに、精密で余裕のある案内として自然に読み上げる。",
      },
      {
        id: "male-butler",
        label: "執事",
        text: "30代の男性で、中低音域の礼儀正しく上品な声。丁寧に案内するよう自然に読み上げ、語尾は柔らかく、信頼感を出す。",
      },
      {
        id: "male-fresh",
        label: "爽やか",
        text: "20代後半の男性で、明るい中音域の爽やかで話しかけやすい声。自然に読み上げ、テンポは少し軽めで、誠実さを出す。",
      },
      {
        id: "male-narrator",
        label: "低音ナレ",
        text: "30代後半の男性で、低音域の安定したナレーター声。控えめに少しゆっくり読み上げ、声の芯は太く、発音は明瞭にする。",
      },
      {
        id: "male-downer",
        label: "ダウナー",
        text: "20代後半の男性で、低めの中音域の静かで気だるい声。淡々と読み、息を少し混ぜ、無関心すぎない優しさを残す。",
      },
    ],
  },
};

const EXPRESSION_STATUS = {
  queued: "未生成",
  generated: "要チェック",
  accepted: "採用",
  soundOnly: "音だけ採用",
  hold: "保留",
  recording: "録音で作る",
  rejected: "ボツ",
};

const SPEAKER_MATERIAL_PROFILES = {
  all: {
    id: "all",
    label: "全部入り",
    suffix: "all",
    description: "採用・音だけ採用をすべて使います。表現幅は広いですが、口腔音や絶叫が多いとこもりやすくなることがあります。",
  },
  clarity: {
    id: "clarity",
    label: "クリア優先",
    suffix: "clarity",
    acceptedOnly: true,
    categories: new Set(["anchor", "laugh", "breath", "surprise", "fear"]),
    description: "通常アンカー、笑い、息づかい、驚き、怖さだけを使います。声の芯と明瞭さを優先し、口腔音・啜り・絶叫・泣きは外します。",
  },
};

const GENERAL_SPEECH_TARGET_COUNT = 100;
const GENERAL_SPEECH_CATEGORIES = [
  {
    id: "book",
    label: "本の朗読",
    target: 16,
    caption: "静かな本の朗読のように、自然な間と落ち着いた抑揚で読み上げる。",
    lines: [
      "朝の光が窓辺に差し込み、机の上に置かれた古い本の表紙をやわらかく照らしていました。",
      "雨上がりの道には小さな水たまりが残り、通り過ぎる人の足音がいつもより静かに響きます。",
      "彼女は手紙をもう一度だけ読み返し、言葉の隙間に残された気持ちを確かめました。",
      "遠くの駅から列車の音が聞こえるたび、町は少しだけ旅の気配を帯びていきます。",
      "森の奥では風が葉を揺らし、誰も知らない小さな物語が今日も続いていました。",
      "夕暮れの台所には温かい湯気が立ちのぼり、食卓の上に穏やかな時間が広がります。",
      "古い写真の中の笑顔は、何年経ってもその日の空気を静かに抱えています。",
      "海辺の小さな町では、朝になると波の音が時計の代わりに一日を知らせてくれます。",
    ],
  },
  {
    id: "weather",
    label: "天気予報",
    target: 12,
    caption: "天気予報のように、明瞭で聞き取りやすく、穏やかなテンポで読み上げる。",
    lines: [
      "今日の東京は午前中を中心に雲が広がりますが、午後は次第に晴れ間が戻る見込みです。",
      "明日の朝は冷え込みが強まります。外出の際は少し厚手の上着を選ぶと安心です。",
      "沿岸部では昼過ぎから風がやや強く吹くため、自転車やバイクでの移動には注意してください。",
      "週末は広い範囲で穏やかな晴れとなり、洗濯物も乾きやすい一日になりそうです。",
      "夕方以降はにわか雨の可能性があります。折りたたみ傘を持って出かけると安心です。",
      "気温は平年より高めで、日中は汗ばむ陽気になります。こまめな水分補給を心がけてください。",
    ],
  },
  {
    id: "news",
    label: "ニュース",
    target: 10,
    caption: "ニュース読みのように、感情を乗せすぎず、情報を正確に伝える。",
    lines: [
      "市内の図書館では、来月から子ども向けの読書イベントが毎週土曜日に開催されます。",
      "新しい地域バスの運行が始まり、駅から商店街までの移動時間が短縮される見通しです。",
      "環境保全を目的とした清掃活動が行われ、参加者は川沿いのごみを丁寧に集めました。",
      "地元の高校生が開発した防災アプリが公開され、避難所情報を簡単に確認できるようになりました。",
      "商店街では季節のフェアが始まり、各店舗が限定商品や特別メニューを用意しています。",
    ],
  },
  {
    id: "guide",
    label: "案内",
    target: 10,
    caption: "受付や館内案内のように、親切で落ち着いた声で読み上げる。",
    lines: [
      "受付は正面入口を入って右側にございます。お名前をお伝えいただき、そのままお待ちください。",
      "お手洗いは廊下の突き当たりを左に曲がった先です。足元にお気をつけてお進みください。",
      "ご予約の時間まで少しありますので、番号が呼ばれるまで待合スペースでお過ごしください。",
      "お忘れ物がございましたら、お近くのスタッフまでお声がけください。すぐに確認いたします。",
      "会場内は飲み物のみお持ち込みいただけます。食事は指定の休憩スペースをご利用ください。",
    ],
  },
  {
    id: "explain",
    label: "説明文",
    target: 12,
    caption: "短い解説動画のように、内容をわかりやすく自然な抑揚で読み上げる。",
    lines: [
      "この機能は、入力された文章をもとに音声を生成し、あとから声の質感を調整できるようにするものです。",
      "まず元になる音声を用意し、次に複数の読み上げ素材を作ることで、声の安定性を高めていきます。",
      "音がこもって聞こえる場合は、低い帯域を少し抑え、高い帯域を控えめに持ち上げると改善することがあります。",
      "保存する前に短い文章と長い文章の両方で試すと、声の癖や不安定な部分に気づきやすくなります。",
      "生成に時間がかかる場合でも、進行状況が見えていれば途中で止まっているかどうかを判断しやすくなります。",
      "最終成果物を作るときは、表現音と一般音声のバランスを確認してから学習に進むことが大切です。",
    ],
  },
  {
    id: "long_reading",
    label: "長めの読み上げ",
    target: 14,
    caption: "長めの文章を、息継ぎと文末を自然に整えながら読み上げる。",
    lines: [
      "駅前の広場には朝から多くの人が行き交い、それぞれの一日が静かに始まっていました。誰かを待つ人、急いで歩く人、立ち止まって空を見る人。そのすべてが町の景色を作っています。",
      "新しい道具を使い始めるときは、最初に大きな成果を求めすぎず、何度か試しながら手に馴染ませていくことが大切です。小さな違和感を直していくほど、作業は自然になっていきます。",
      "午後の休憩時間になると、部屋の空気は少しだけやわらかくなります。温かい飲み物を一口飲み、画面から目を離して深呼吸をすると、次に進むための余白が戻ってきます。",
      "長く続く作業では、速さよりも確認のしやすさが重要です。どこまで終わったのか、何が残っているのかを見える形にしておくと、途中で迷う時間を減らすことができます。",
      "声の印象は、音の高さだけでは決まりません。話す速度、息の量、言葉の切り方、文末の残し方が重なって、その人らしい距離感や温度が生まれます。",
      "静かな場所で本を読むと、普段は通り過ぎてしまう言葉がゆっくりと耳に残ります。意味を急がず、文章の流れに身を任せることで、声の自然さも少しずつ整っていきます。",
      "今日の作業は、素材を集めることから始まります。良い素材がそろっているほど、あとで調整するときの選択肢が増え、失敗した原因も見つけやすくなります。",
    ],
  },
  {
    id: "diary",
    label: "日記",
    target: 8,
    caption: "日記を読むように、近い距離で柔らかく自然に読み上げる。",
    lines: [
      "今日は少し早く起きられたので、朝のうちに部屋を片づけました。空気がすっきりして、気持ちも軽くなりました。",
      "帰り道に見た夕焼けがきれいで、思わず写真を撮りました。何でもない一日でも、こういう瞬間があると嬉しくなります。",
      "予定より作業に時間がかかりましたが、途中で投げ出さずに最後まで進められたので、今日はそれだけで十分です。",
      "久しぶりにゆっくりお茶を飲みました。短い時間でも、静かに座っているだけで少し回復する気がします。",
    ],
  },
  {
    id: "conversation",
    label: "自然会話",
    target: 8,
    caption: "日常会話のように、硬すぎず、近い距離感で自然に読み上げる。",
    lines: [
      "それなら、まず短い文章で試してみましょう。うまくいったら、少し長い文章に変えて確認します。",
      "今の感じは悪くないと思います。もう少しだけ明るくすると、聞き取りやすさが上がるかもしれません。",
      "急がなくて大丈夫です。ひとつずつ確認していけば、どこで変わったのかちゃんとわかります。",
      "この設定は保存しておきましょう。あとで比べたときに、どちらが良かったか判断しやすくなります。",
    ],
  },
  {
    id: "announcement",
    label: "アナウンス",
    target: 5,
    caption: "公共アナウンスのように、少し遠めで聞き取りやすく読み上げる。",
    lines: [
      "まもなく開場いたします。入場券をお手元にご用意のうえ、案内に従ってお進みください。",
      "ただいま準備中です。開始まで今しばらくお待ちください。ご理解とご協力をお願いいたします。",
      "お帰りの際は、足元とお忘れ物にご注意ください。本日はご来場いただきありがとうございました。",
      "次の便は十時三十分発です。乗り場をお確かめのうえ、時間に余裕を持ってお越しください。",
      "混雑緩和のため、順番にご案内いたします。係員の指示があるまで、その場でお待ちください。",
    ],
  },
  {
    id: "instruction",
    label: "手順説明",
    target: 5,
    caption: "操作手順を説明するように、短く区切って正確に読み上げる。",
    lines: [
      "最初にファイルを選びます。次に名前を入力し、内容を確認してから保存ボタンを押してください。",
      "設定を変更したら、必ず一度再生して音を確認します。問題がなければ次の工程へ進みます。",
      "画面左側で素材を選び、中央で内容を確認します。右側には現在の音量波形が表示されます。",
      "途中でやり直したい場合は、クリアボタンを押して候補を削除し、もう一度リストを作成します。",
      "作成が終わったら、成果物テストで短い文章と長い文章を読み上げ、声の安定性を確認します。",
    ],
  },
];

const FEMALE_EXPRESSION_CATEGORIES = [
  {
    id: "anchor",
    label: "通常アンカー",
    target: 10,
    caption: "自然な日本語話者。近い距離で、明瞭に、感情を入れすぎず読み上げる。",
    lines: [
      "今日は短い確認だけお願いします。声の距離感と明瞭さを確かめます。",
      "大丈夫です。少しゆっくり息を整えてから、もう一度話します。",
      "ここから声の表情を変えます。落ち着いたまま、自然に読みます。",
      "次の予定を確認します。必要なところだけ短くまとめます。",
      "今の声は近めです。息づかいは控えめで、輪郭ははっきりしています。",
    ],
  },
  {
    id: "laugh",
    label: "笑い",
    target: 8,
    caption: "声を張りすぎず、短い笑い、含み笑い、息だけの笑いを自然に混ぜる。",
    lines: [
      "ふふっ……ちょっと、今のはずるいです。",
      "くすっ、だめです、笑わないつもりだったのに。",
      "あはっ、あはは……もう一回言ってください。",
      "へへっ……なんだか少し安心しました。",
      "ふっ、ふふ……息だけで小さく笑う感じです。",
    ],
  },
  {
    id: "breath",
    label: "息づかい",
    target: 15,
    caption: "息の音が前に出る。荒い呼吸、息が詰まりそうな演技、緊張、疲れを台詞に混ぜる。",
    lines: [
      "はぁ、はぁ、はぁっ……ちょっと待って、息を整えます。",
      "すぅ……はぁ……もう大丈夫、落ち着いて話します。",
      "はっ、はっ、はっ……急いで来たので、少しだけ待ってください。",
      "ふぅ……よかった。本当に、間に合いました。",
      "はぁ……っ、声が震えないように、ゆっくり言います。",
      "はぁっ、はぁっ……待って、まだ、うまく話せないです。",
      "すぅ……っ、はぁ……息が浅くて、少し苦しいです。",
      "はっ、はっ……お願い、少しだけ時間をください。",
      "んっ……はぁ、はぁ……言葉の途中で息が切れます。",
      "はぁ……はぁ……怖いけど、ちゃんと伝えます。",
      "すぅっ……はぁっ……胸がぎゅっとして、声が細くなります。",
      "はっ……はっ……大丈夫、大丈夫って言い聞かせています。",
      "ふぅ……はぁ……緊張が抜けなくて、息だけ先に出ます。",
      "はぁ、はぁ……ちょっとだけ、待ってください。",
      "んんっ……はぁ……息を飲んでから、ゆっくり戻します。",
    ],
  },
  {
    id: "throat",
    label: "喉・詰まり",
    target: 10,
    caption: "喉が詰まる、言葉が止まる、飲み込む前の短い声を作る。",
    lines: [
      "んぐっ……ごめんなさい、今ちょっと詰まりました。",
      "くっ……言葉が、すぐに出てこないです。",
      "んっ……あ、すみません。もう一度言います。",
      "うっ……喉の奥で止まったみたいな声です。",
      "ングッ……だ、大丈夫です。続けます。",
    ],
  },
  {
    id: "cough",
    label: "むせ・咳",
    target: 10,
    caption: "軽い咳、むせ、声が乱れる瞬間を誇張しすぎず入れる。",
    lines: [
      "こほっ、こほ……すみません、少しむせました。",
      "げほっ、んん……大丈夫です、続けます。",
      "けほっ……あ、喉に引っかかりました。",
      "こほ、こほっ……水を飲めば落ち着きます。",
      "んっ、げほ……ごめんなさい、もう一回言います。",
    ],
  },
  {
    id: "swallow",
    label: "飲み込み",
    target: 10,
    caption: "飲み込む、喉が鳴る、短く息を止める音を含める。",
    lines: [
      "ごくっ……はい、落ち着きました。",
      "こくん……少し緊張していました。",
      "んっ……ごくっ、もう大丈夫です。",
      "ごく、ごく……ぷはっ、続けます。",
      "ん……こくっ。声を出す前に飲み込みました。",
    ],
  },
  {
    id: "suction",
    label: "吸う音・口腔音",
    target: 15,
    caption: "口先で吸う、短くすする、ちゅるっとした音、唇や舌先の小さな音を試す。",
    lines: [
      "ちゅる……んっ、少し吸い込むような音です。",
      "ちゅうぅ……ぷはっ、短く息を戻します。",
      "すぅーっ……ん、音を小さく残します。",
      "ちゅる、ちゅるっ……あ、もう少しだけ。",
      "すっ、ちゅる……口先で軽く吸う感じです。",
      "んっ……ちゅっ、すみません、音が少し入りました。",
      "ちゅ、ちゅる……ふぅ、短く区切ります。",
      "すっ……ちゅう……ぷは、息を戻します。",
      "ちゅるる……んっ、軽く吸って止めます。",
      "ぴちゃ……ん、口の中で小さく鳴りました。",
      "ちゅっ……ふぅ、近い距離で小さく出します。",
      "すぅ……ちゅる……声に混じる口先の音です。",
      "ん……ちゅっ、ちゅる……少しだけ繰り返します。",
      "ちゅうぅ……んっ、強すぎないように戻します。",
      "すっ、ぴちゃ……あ、短い口腔音です。",
    ],
  },
  {
    id: "sensual",
    label: "艶っぽい吐息",
    target: 15,
    fixedQuotas: {
      12: 3,
      50: 8,
      100: 15,
      145: 15,
    },
    caption: "成人女性の、上品で少し艶っぽい吐息と声にならない短い声。甘さ、戸惑い、照れ、余韻を露骨にしすぎず自然に混ぜる。",
    lines: [
      "んっ……んっ、んーーーっ…………ふぅ……。",
      "あっ……んっ……ああぁーー……はぁ……。",
      "ん……っ、んん……ふぅ……少しだけ、息が漏れました。",
      "あ……っ、んっ……ふふ……近いと、少し照れます。",
      "んっ……ん、んっ……はぁ……ゆっくり、息を抜きます。",
      "あっ……ん……んんっ……大丈夫、落ち着いて話します。",
      "はぁ……はぁ……んっ……声が、少し震えます。",
      "んーー……っ……ふぅ……長めに余韻を残します。",
      "あ……っ、だめ……声が少し、出ちゃいました。",
      "んっ……ふぅ……もう少しだけ、静かに言います。",
      "あっ……んっ、ん……ふふ……ちょっと、くすぐったいです。",
      "ん……んんっ……はぁ……言葉にするのが、少し恥ずかしいです。",
      "ふぅ……んっ……んーー……近い距離で、小さく息を漏らします。",
      "ああ……っ、ん……はぁ……ゆっくり戻ります。",
      "んっ……んっんっ……ふぅ……短く息を重ねます。",
      "あっ……はぁ……ん……少し甘く、でも抑えて話します。",
      "ん……っ、んーーー…………あ……少しだけ、余韻を残します。",
      "はぁ……んっ……あぁ……声を張らずに、細く出します。",
      "んっ……だめ、笑わないで……ちょっと照れます。",
      "あ……んっ……ふぅ……もう大丈夫、続けます。",
    ],
  },
  {
    id: "slurp",
    label: "啜り・麺",
    target: 8,
    caption: "麺を啜るような長めの息と摩擦音を試す。うまく出ない候補を見つける。",
    lines: [
      "ズズッ……ズズズズーーッ、ぷはっ。",
      "ずぞぞっ、ずずっ……んっ、もう一口。",
      "すぅーっ、ずずずっ……ぷは、熱いです。",
      "ちゅる、ちゅるるっ……んぐっ、ゆっくり飲み込みます。",
      "ズズズーーッ、ずっ、ずず……はぁ、少し熱かったです。",
    ],
  },
  {
    id: "surprise",
    label: "驚き",
    target: 6,
    caption: "短く跳ねる声。ひゃっ、えっ、わっと反射的に出る声を作る。",
    lines: [
      "ひゃっ！？ びっくりした……急に来ないでください。",
      "えっ、今の音、聞こえました？",
      "わっ、待って、そこにいるとは思いませんでした。",
      "ひぃっ……ごめんなさい、驚いただけです。",
      "あっ、だめ、そこは触らないでください。",
    ],
  },
  {
    id: "fear",
    label: "怖さ・震え",
    target: 8,
    caption: "小さく震える声、泣きそうな声、恐怖で息が乱れる声を作る。",
    lines: [
      "いや……来ないで。お願い、もう近づかないで。",
      "ううっ……声が震えて、うまく言えません。",
      "だめ、だめです……ここから先は行けません。",
      "お願い、助けて……一人にしないでください。",
      "はぁっ、はぁ……怖いけど、ちゃんと伝えます。",
    ],
  },
  {
    id: "scream",
    label: "絶叫・パニック",
    target: 15,
    fixedQuotas: {
      12: 3,
      50: 8,
      100: 15,
      145: 15,
    },
    caption: "追い詰められた悲鳴、声割れ、息切れ、反射的な叫びを混ぜる。恐怖は強めだが描写は非グロに抑える。",
    lines: [
      "きゃあああああっ！ 来ないで、来ないでええっ！",
      "いやっ、いやいやいやっ……誰か、助けて！",
      "ひっ……目の前に、いる……っ、やだ、やだあああ！",
      "ああああああっ！ もう無理、もう無理だってば！",
      "待って、置いていかないで！ お願い、お願いだから！",
      "いやあああああっ！ そこ、閉めて、早く閉めてえっ！",
      "はぁっ、はぁっ……来る、来るよ、こっち来る！",
      "だめ、だめだめだめっ！ 逃げて、早く逃げて！",
      "ひゃああっ！？ やだ、触らないで、やめてえっ！",
      "お願い、声が出ない……っ、誰か、誰かああっ！",
      "あっ、あっ、あああっ！ もうそこで止まって、お願い！",
      "きゃっ、きゃあああっ！ 無理、もう本当に無理です！",
      "いや、いやっ……来ないでって言ってるでしょおお！",
      "はぁっ、はぁ……目を開けられない、怖い、怖いよ！",
      "うわああああっ！ だめ、こっち見ないでええっ！",
    ],
  },
  {
    id: "crying",
    label: "泣き・懇願",
    target: 15,
    fixedQuotas: {
      12: 3,
      50: 8,
      100: 15,
      145: 15,
    },
    caption: "泣き声、しゃくり上げ、謝罪、懇願を入れる。言葉が崩れすぎない範囲で涙声にする。",
    lines: [
      "わぁぁぁぁん……ごめんなさい、ごめんなさい……。",
      "ゆ、許してください……もう、もうしませんから……。",
      "お願いです……もう堪忍してぇぇ……。",
      "ううっ……ひっく……声が、うまく出ないです。",
      "ごめんなさい……私が悪かったです……だから、お願い……。",
      "やだ……置いていかないで……ひとりにしないで……。",
      "わああん……違うんです、違うんです……聞いてください。",
      "ひっく……ひっく……もう大丈夫って、言ってください……。",
      "お願い……怒らないで……ちゃんと、ちゃんと直します……。",
      "うう……ごめんなさい……怖くて、何も言えませんでした。",
      "ゆるして……ください……もう、声が震えて止まりません。",
      "わぁぁん……私、どうしたらいいですか……。",
      "ひっく……ごめん、なさい……ちゃんと言いたいのに……。",
      "お願いです……もう一回だけ、やり直させてください……。",
      "ううっ……泣かないって決めたのに、止まらないです……。",
    ],
  },
  {
    id: "power_shout",
    label: "強い叫び",
    target: 10,
    fixedQuotas: {
      12: 1,
      50: 5,
      100: 10,
      145: 15,
    },
    caption: "怒り、抵抗、全力で制止する強い叫び。女性声の高さは残しつつ、声を張って勢いを出す。",
    lines: [
      "ふざけないでぇぇぇ！ もう我慢できない！",
      "やめてえええ！ それ以上、近づかないで！",
      "来ないでえええ！ そこから動かないで！",
      "だめえええ！ 絶対に、そんなの許さない！",
      "返してえええ！ それは私の大事なものなの！",
      "逃げてえええ！ 早く、早く逃げて！",
      "触らないでえええ！ 今すぐ離れて！",
      "もうやめてえええ！ 聞こえてるでしょ！",
      "助けてえええ！ 誰か、誰か来て！",
      "違うって言ってるでしょおおお！",
      "こっちに来ないでえええ！",
      "いやあああっ！ そんなの絶対いや！",
      "お願いだから止まってえええ！",
      "何してるのよおおお！ ふざけないで！",
      "もう限界なの、やめてえええ！",
    ],
  },
];

const MALE_EXPRESSION_CATEGORIES = [
  {
    id: "anchor",
    label: "通常アンカー",
    target: 10,
    caption: "男性の自然な日本語話者。中低音域から低音域で、明瞭に、感情を入れすぎず読み上げる。",
    lines: [
      "今日は短い確認だけお願いします。声の距離感と明瞭さを確かめます。",
      "大丈夫です。少しゆっくり息を整えてから、もう一度話します。",
      "ここから声の表情を変えます。落ち着いたまま、自然に読みます。",
      "次の予定を確認します。必要なところだけ短くまとめます。",
      "今の声は近めです。息づかいは控えめで、輪郭ははっきりしています。",
    ],
  },
  {
    id: "laugh",
    label: "笑い",
    target: 8,
    caption: "男性の短い笑い、低めの含み笑い、息だけの笑いを自然に混ぜる。",
    lines: [
      "ふっ……今のは、少し笑ってしまいました。",
      "ははっ、すみません。油断しました。",
      "くくっ……いや、なんでもありません。",
      "へへっ……少し安心しただけです。",
      "ふっ、ふふ……声を張らずに小さく笑います。",
    ],
  },
  {
    id: "breath",
    label: "息づかい",
    target: 15,
    caption: "男性の荒い呼吸、緊張した息、疲れた息を台詞に混ぜる。",
    lines: [
      "はぁ、はぁ、はぁっ……少し待ってください。",
      "すぅ……はぁ……落ち着いて、もう一度言います。",
      "はっ、はっ、はっ……急いで来たので、息が切れています。",
      "ふぅ……間に合った。本当に、ぎりぎりでした。",
      "はぁ……声が震えないように、ゆっくり言います。",
      "はぁっ、はぁっ……まだ、うまく話せません。",
      "すぅ……っ、はぁ……少し胸が苦しいです。",
      "はっ……はっ……少しだけ時間をください。",
      "んっ……はぁ、はぁ……言葉の途中で息が切れます。",
      "はぁ……はぁ……怖いが、ちゃんと伝えます。",
      "すぅっ……はぁっ……息が浅くなっています。",
      "はっ……はっ……大丈夫だと自分に言い聞かせています。",
      "ふぅ……はぁ……緊張が抜けません。",
      "はぁ、はぁ……少しだけ待ってください。",
      "んんっ……はぁ……息を飲んでから、戻します。",
    ],
  },
  {
    id: "throat",
    label: "喉・詰まり",
    target: 10,
    caption: "男性の喉が詰まる、言葉が止まる、飲み込む前の短い声を作る。",
    lines: [
      "んぐっ……すみません、少し詰まりました。",
      "くっ……言葉が、すぐに出てきません。",
      "んっ……失礼しました。もう一度言います。",
      "うっ……喉の奥で止まったような声です。",
      "ングッ……大丈夫です。続けます。",
    ],
  },
  {
    id: "cough",
    label: "むせ・咳",
    target: 10,
    caption: "男性の軽い咳、むせ、声が乱れる瞬間を入れる。",
    lines: [
      "こほっ、こほ……すみません、少しむせました。",
      "げほっ、んん……大丈夫です、続けます。",
      "けほっ……喉に引っかかりました。",
      "こほ、こほっ……水を飲めば落ち着きます。",
      "んっ、げほ……失礼しました、もう一回言います。",
    ],
  },
  {
    id: "swallow",
    label: "飲み込み",
    target: 10,
    caption: "男性の飲み込み、喉が鳴る、短く息を止める音を含める。",
    lines: [
      "ごくっ……はい、落ち着きました。",
      "こくん……少し緊張していました。",
      "んっ……ごくっ、もう大丈夫です。",
      "ごく、ごく……ぷはっ、続けます。",
      "ん……こくっ。声を出す前に飲み込みました。",
    ],
  },
  {
    id: "suction",
    label: "吸う音・口腔音",
    target: 10,
    caption: "男性の短い吸気、口先の小さな音、息を戻す音を試す。",
    lines: [
      "すぅ……んっ、短く吸い込む音です。",
      "ちゅっ……ぷはっ、短く息を戻します。",
      "すぅーっ……音を小さく残します。",
      "すっ、ちゅ……軽く吸う感じです。",
      "んっ……すみません、音が少し入りました。",
      "すっ……ふぅ、短く区切ります。",
      "すぅ……ぷは、息を戻します。",
      "ん……ちゅっ、少しだけ鳴りました。",
      "すぅ……声に混じる口先の音です。",
      "すっ……小さな口腔音です。",
    ],
  },
  {
    id: "sensual",
    label: "低い吐息",
    target: 10,
    fixedQuotas: {
      12: 2,
      50: 5,
      100: 10,
      145: 10,
    },
    caption: "成人男性の低い吐息、近い距離の声にならない短い声。落ち着きと余韻を出す。",
    lines: [
      "んっ……ふぅ……少しだけ、息が漏れました。",
      "あ……っ、ん……落ち着いて、続けます。",
      "ん……っ、んん……ふぅ……声を低く戻します。",
      "はぁ……んっ……少し近い距離で話します。",
      "んっ……ん、んっ……ゆっくり息を抜きます。",
      "あっ……ん……大丈夫、落ち着いて話します。",
      "はぁ……はぁ……んっ……声が少し震えます。",
      "んーー……っ……ふぅ……長めに余韻を残します。",
      "んっ……ふぅ……もう少し静かに言います。",
      "はぁ……ん……声を張らずに、低く出します。",
    ],
  },
  {
    id: "slurp",
    label: "啜り・麺",
    target: 8,
    caption: "男性の麺を啜るような長めの息と摩擦音を試す。",
    lines: [
      "ズズッ……ズズズズーーッ、ぷはっ。",
      "ずぞぞっ、ずずっ……んっ、もう一口。",
      "すぅーっ、ずずずっ……ぷは、熱いです。",
      "ちゅる、ちゅるるっ……んぐっ、ゆっくり飲み込みます。",
      "ズズズーーッ、ずっ、ずず……はぁ、少し熱かったです。",
    ],
  },
  {
    id: "surprise",
    label: "驚き",
    target: 6,
    caption: "男性の短く跳ねる声。えっ、うわっ、と反射的に出る声を作る。",
    lines: [
      "うわっ！？ びっくりした……急に来ないでください。",
      "えっ、今の音、聞こえました？",
      "わっ、待って、そこにいるとは思いませんでした。",
      "ひっ……いや、驚いただけです。",
      "あっ、だめです。そこは触らないでください。",
    ],
  },
  {
    id: "fear",
    label: "怖さ・震え",
    target: 8,
    caption: "男性の小さく震える声、恐怖で息が乱れる声を作る。",
    lines: [
      "やめろ……来るな。頼む、もう近づかないでくれ。",
      "ううっ……声が震えて、うまく言えません。",
      "だめだ……ここから先は行けません。",
      "頼む、助けてくれ……一人にしないでください。",
      "はぁっ、はぁ……怖いが、ちゃんと伝えます。",
    ],
  },
  {
    id: "scream",
    label: "絶叫・パニック",
    target: 12,
    fixedQuotas: {
      12: 2,
      50: 6,
      100: 12,
      145: 12,
    },
    caption: "男性の追い詰められた叫び、声割れ、息切れ、反射的な叫びを混ぜる。",
    lines: [
      "うわあああああっ！ 来るな、来るなああっ！",
      "やめろっ、やめろやめろっ……誰か、助けてくれ！",
      "ひっ……目の前に、いる……っ、だめだ、だめだあああ！",
      "ああああああっ！ もう無理だ、無理だって！",
      "待ってくれ、置いていくな！ 頼む、頼むから！",
      "うわああああっ！ そこを閉めろ、早く閉めろおっ！",
      "はぁっ、はぁっ……来る、来るぞ、こっちに来る！",
      "だめだ、だめだめだめっ！ 逃げろ、早く逃げろ！",
      "触るなっ、やめろ、やめてくれえっ！",
      "声が出ない……っ、誰か、誰かああっ！",
      "あっ、あっ、あああっ！ そこで止まれ、頼む！",
      "うわっ、うわあああっ！ 本当に無理だ！",
    ],
  },
  {
    id: "crying",
    label: "泣き・懇願",
    target: 12,
    fixedQuotas: {
      12: 2,
      50: 6,
      100: 12,
      145: 12,
    },
    caption: "男性の泣き声、しゃくり上げ、謝罪、懇願を入れる。言葉が崩れすぎない範囲で涙声にする。",
    lines: [
      "ううっ……すみません、すみません……。",
      "ゆ、許してください……もう、二度としませんから……。",
      "頼みます……もう勘弁してください……。",
      "ううっ……声が、うまく出ません。",
      "すみません……俺が悪かったです……だから、お願いします……。",
      "置いていかないでくれ……一人にしないで……。",
      "違うんです、違うんです……聞いてください。",
      "ひっく……もう大丈夫だって、言ってください……。",
      "頼む……怒らないでくれ……ちゃんと直します……。",
      "うう……怖くて、何も言えませんでした。",
      "ゆるして……ください……声が震えて止まりません。",
      "お願いします……もう一回だけ、やり直させてください……。",
    ],
  },
  {
    id: "power_shout",
    label: "強い叫び",
    target: 10,
    fixedQuotas: {
      12: 1,
      50: 5,
      100: 10,
      145: 15,
    },
    caption: "男性の怒号、抵抗、全力で制止する強い叫び。低音の芯と声割れを出す。",
    lines: [
      "ウオォォォォォォォ！ ふざけるなぁぁぁ！！！",
      "はぁぁぁぁぁっ！ もう限界だ、どけえええ！",
      "黙れぇぇぇ！ これ以上、好きにはさせない！",
      "来るなぁぁぁ！ そこから一歩も動くな！",
      "やめろおおお！ それ以上やったら許さない！",
      "逃げろおおお！ 早く、早く行け！",
      "返せぇぇぇ！ 今すぐそれを返せ！",
      "ふざけるなぁぁぁ！ 俺は認めない！",
      "止まれえええ！ 聞こえてるだろ！",
      "うおおおおおっ！ 絶対に負けるか！",
      "こっちを見るなぁぁぁ！",
      "俺に任せろおおお！ 早く下がれ！",
      "もう終わりだぁぁぁ！ そこをどけ！",
      "何してるんだあああ！ ふざけるな！",
      "はぁぁぁぁっ！ 全部、止めてやる！",
    ],
  },
];

const EXPRESSION_CATEGORY_SETS = {
  female: FEMALE_EXPRESSION_CATEGORIES,
  male: MALE_EXPRESSION_CATEGORIES,
};

const selectableModelIds = new Set(FALLBACK_MODELS.map((model) => model.id));

function normalizeVoicePresetGroup(value) {
  return value === "male" ? "male" : "female";
}

function currentExpressionGender() {
  return normalizeVoicePresetGroup(activeVoicePresetGroup);
}

function expressionGenderLabel(gender = currentExpressionGender()) {
  return normalizeVoicePresetGroup(gender) === "male" ? "男性" : "女性";
}

function currentExpressionCategories() {
  return EXPRESSION_CATEGORY_SETS[currentExpressionGender()] || FEMALE_EXPRESSION_CATEGORIES;
}

function inferVoicePresetGroupFromCaption(caption) {
  const normalized = String(caption || "").trim();
  for (const [groupId, group] of Object.entries(VOICE_CAPTION_PRESETS)) {
    if (group.presets.some((preset) => preset.text === normalized)) return groupId;
  }
  return /男性|男声|低音域|中低音域|執事|Jarvis|AI秘書/.test(normalized) ? "male" : "female";
}

function renderVoiceCaptionPresets() {
  const tabs = $("voicePresetTabs");
  const grid = $("voicePresetGrid");
  if (!tabs || !grid) return;
  tabs.innerHTML = Object.entries(VOICE_CAPTION_PRESETS)
    .map(([groupId, group]) => {
      const active = groupId === activeVoicePresetGroup;
      return `
        <button class="voice-preset-tab ${active ? "is-active" : ""}" type="button" data-voice-preset-group="${escapeHtml(groupId)}" aria-pressed="${active ? "true" : "false"}">
          ${escapeHtml(group.label)}
        </button>
      `;
    })
    .join("");
  const group = VOICE_CAPTION_PRESETS[activeVoicePresetGroup] || VOICE_CAPTION_PRESETS.female;
  grid.innerHTML = group.presets
    .map(
      (preset) => `
        <button class="voice-preset-chip" type="button" data-voice-preset-id="${escapeHtml(preset.id)}" title="${escapeHtml(preset.text)}">
          <strong>${escapeHtml(preset.label)}</strong>
          <span>${escapeHtml(preset.text)}</span>
        </button>
      `,
    )
    .join("");
  tabs.querySelectorAll("[data-voice-preset-group]").forEach((button) => {
    button.addEventListener("click", () => {
      activeVoicePresetGroup = normalizeVoicePresetGroup(button.dataset.voicePresetGroup);
      renderVoiceCaptionPresets();
      renderExpressionCategories();
    });
  });
  grid.querySelectorAll("[data-voice-preset-id]").forEach((button) => {
    button.addEventListener("click", () => applyVoiceCaptionPreset(button.dataset.voicePresetId || ""));
  });
}

function applyVoiceCaptionPreset(presetId) {
  const groups = Object.entries(VOICE_CAPTION_PRESETS);
  const matchedGroup = groups.find(([, group]) => group.presets.some((item) => item.id === presetId));
  const preset = matchedGroup?.[1].presets.find((item) => item.id === presetId);
  if (!preset) return;
  activeVoicePresetGroup = normalizeVoicePresetGroup(matchedGroup?.[0]);
  $("voiceCaption").value = preset.text;
  $("voiceCaption").dispatchEvent(new Event("input", { bubbles: true }));
  renderVoiceCaptionPresets();
  renderExpressionCategories();
  log(`音声プロンプトを適用しました: ${preset.label}`);
}

function readSettings() {
  return {
    endpoint: $("endpoint").value,
    model: normalizeModelChoice($("model").value),
    format: $("format").value,
    apiKey: $("apiKey").value,
    voice: $("voice").value,
    expressionSourceMode: expressionSourceMode(),
    scriptCue: $("scriptCue").value,
    scriptLength,
    activeLabTab,
    seedQuality,
    labEngineProfile: LAB_ENGINE_PROFILE,
    text: $("text").value,
    caption: $("voiceCaption").value.trim(),
    voiceCaption: $("voiceCaption").value,
    speed: Number($("speed").value),
    pitch: Number($("pitch").value),
    seed: $("seed").value.trim(),
    numSteps: Number($("numSteps").value),
    cfgMode: $("cfgMode").value,
    cfgText: Number($("cfgText").value),
    cfgCaption: Number($("cfgCaption").value),
    cfgSpeaker: Number($("cfgSpeaker").value),
    scheduleMode: $("schedule").value,
    swayCoeff: Number($("sway").value),
    durationScale: DEFAULT_IRODORI_DURATION_SCALE,
    sculpt: readSculptSettings(),
  };
}

function readSculptSettings() {
  return {
    hpfHz: Number($("hpfHz").value),
    peakTargetDb: normalizePeakTargetDb($("peakTargetDb")?.value),
    deepFilterMode: normalizeDeepFilterMode($("deepFilterMode")?.value),
    gainDb: Number($("gainDb").value),
    lowDb: Number($("lowDb").value),
    midDb: Number($("midDb").value),
    highDb: Number($("highDb").value),
    presenceDb: Number($("presenceDb").value),
    airDb: Number($("airDb").value),
  };
}

function normalizeModelChoice(modelId) {
  const normalized = String(modelId || "").trim();
  if (normalized === "irodori-tts") return "irodori-lite-auto";
  return selectableModelIds.has(normalized) ? normalized : DEFAULT_MODEL;
}

function migrateLegacyCfgDefaults(settings = {}) {
  const migrated = { ...settings };
  const oldText = Number(migrated.cfgText);
  const oldCaption = Number(migrated.cfgCaption);
  const oldSpeaker = Number(migrated.cfgSpeaker);
  if ([2.0, 2.5].includes(oldText)) migrated.cfgText = 1.0;
  if ([3.0, 4.0, 4.5].includes(oldCaption)) migrated.cfgCaption = 1.0;
  if (oldSpeaker === 4.0) migrated.cfgSpeaker = 1.0;
  return migrated;
}

function migrateSettings(settings = {}) {
  let migrated =
    settings.labEngineProfile === LAB_ENGINE_PROFILE
      ? { ...settings }
      : {
          ...settings,
          model: DEFAULT_MODEL,
          voice: "none",
          seedQuality: "standard",
          numSteps: 40,
          cfgText: 1.0,
          cfgCaption: 1.0,
          cfgSpeaker: DEFAULT_REFERENCE_CFG_SPEAKER,
          schedule: "linear",
          scheduleMode: "linear",
          labEngineProfile: LAB_ENGINE_PROFILE,
        };
  if (LEGACY_DEFAULT_VOICE_CAPTIONS.has(String(migrated.voiceCaption || "").trim())) {
    migrated.voiceCaption = DEFAULT_VOICE_CAPTION;
  }
  migrated = migrateLegacyCfgDefaults(migrated);
  return migrated;
}

function applySettings(settings) {
  if (settings.seedQuality) seedQuality = normalizeSeedQuality(settings.seedQuality);
  fields.forEach((field) => {
    const mappedValue =
      field === "schedule"
        ? settings.schedule ?? settings.scheduleMode
        : field === "sway"
          ? settings.sway ?? settings.swayCoeff
          : field in (settings.sculpt || {})
            ? settings.sculpt[field]
          : settings[field];
    if (mappedValue === undefined) return;
    $(field).value = field === "model" ? normalizeModelChoice(mappedValue) : mappedValue;
  });
  activeVoicePresetGroup = inferVoicePresetGroupFromCaption(settings.voiceCaption);
  renderVoiceCaptionPresets();
  syncSeedQuickInput();
  syncSeedQualityButtons();
  updateSliderLabels();
  updatePayloadPreview();
}

function setLabTab(tabName) {
  const validTabs = new Set(["seed", "expression", "review", "finish", "test"]);
  activeLabTab = validTabs.has(tabName) ? tabName : "seed";
  document.body.dataset.activeLabTab = activeLabTab;
  document.querySelectorAll("[data-lab-tab-target]").forEach((button) => {
    const isActive = button.dataset.labTabTarget === activeLabTab;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
  document.querySelectorAll("[data-lab-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.labPanel !== activeLabTab;
  });
  const playerRack = $("playerRack");
  const targetMount =
    activeLabTab === "test"
      ? $("playerMountTest")
      : activeLabTab === "finish"
      ? $("playerMountFinish")
      : activeLabTab === "review"
        ? $("playerMountReview")
        : $("playerMountSeed");
  if (playerRack && targetMount && playerRack.parentElement !== targetMount) {
    targetMount.appendChild(playerRack);
  }
  try {
    const settings = readSettings();
    saveSettings({ ...settings, activeLabTab });
  } catch {
    // Some fields may not be ready during first boot.
  }
}

function normalizeSeedQuality(value) {
  return ["draft", "standard", "high"].includes(value) ? value : "standard";
}

function seedQualityPreset(value) {
  const quality = normalizeSeedQuality(value);
  return {
    draft: { steps: 16, cfgText: 1.0, cfgCaption: 1.0, cfgSpeaker: DEFAULT_REFERENCE_CFG_SPEAKER },
    standard: { steps: 40, cfgText: 1.0, cfgCaption: 1.0, cfgSpeaker: DEFAULT_REFERENCE_CFG_SPEAKER },
    high: { steps: 64, cfgText: 1.0, cfgCaption: 1.0, cfgSpeaker: DEFAULT_REFERENCE_CFG_SPEAKER },
  }[quality];
}

function ensureReferenceSpeakerStrength() {
  const current = Number($("cfgSpeaker").value);
  if (!Number.isFinite(current) || current <= 0) {
    $("cfgSpeaker").value = DEFAULT_REFERENCE_CFG_SPEAKER;
  }
}

function syncSeedQualityButtons() {
  document.querySelectorAll("[data-seed-quality]").forEach((button) => {
    const isActive = button.dataset.seedQuality === seedQuality;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function inferSeedQualityFromSettings() {
  const steps = Number($("numSteps").value);
  if (Number.isFinite(steps) && steps >= 56) return "high";
  if (Number.isFinite(steps) && steps <= 24) return "draft";
  return "standard";
}

function applySeedQuality(value, { save = true } = {}) {
  seedQuality = normalizeSeedQuality(value);
  const preset = seedQualityPreset(seedQuality);
  $("numSteps").value = preset.steps;
  $("cfgText").value = preset.cfgText;
  $("cfgCaption").value = preset.cfgCaption;
  $("cfgSpeaker").value = preset.cfgSpeaker;
  syncSeedQualityButtons();
  updateSliderLabels();
  updatePayloadPreview();
  if (save) saveSettings(readSettings());
}

function syncSeedQuickInput() {
  const quick = $("seedQuick");
  if (!quick) return;
  quick.value = $("seed").value;
}

function updateSliderLabels() {
  $("speedValue").textContent = Number($("speed").value).toFixed(2);
  $("pitchValue").textContent = Number($("pitch").value).toFixed(1);
  $("numStepsValue").textContent = $("numSteps").value;
  $("gainValue").textContent = `${Number($("gainDb").value).toFixed(1)}dB`;
  $("lowValue").textContent = `${Number($("lowDb").value).toFixed(1)}dB`;
  $("midValue").textContent = `${Number($("midDb").value).toFixed(1)}dB`;
  $("highValue").textContent = `${Number($("highDb").value).toFixed(1)}dB`;
  $("presenceValue").textContent = `${Number($("presenceDb").value).toFixed(1)}dB`;
  $("airValue").textContent = `${Number($("airDb").value).toFixed(1)}dB`;
  syncHpfButtons();
  syncPeakGuardButtons();
  syncDeepFilterButtons();
  syncAllEqFaders();
}

function syncAllEqFaders() {
  document.querySelectorAll(".eq-slider").forEach((slider) => slider.syncEqFader?.());
}

function normalizeHpfHz(value) {
  const numeric = Number(value);
  return [0, 90, 120, 150].includes(numeric) ? numeric : 0;
}

function effectiveHpfFrequency(value) {
  const hpfHz = normalizeHpfHz(value);
  return hpfHz > 0 ? hpfHz : 10;
}

function syncHpfButtons() {
  const current = normalizeHpfHz($("hpfHz")?.value);
  document.querySelectorAll("[data-hpf-hz]").forEach((button) => {
    const active = normalizeHpfHz(button.dataset.hpfHz) === current;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setHpfPreset(value) {
  $("hpfHz").value = String(normalizeHpfHz(value));
  $("hpfHz").dispatchEvent(new Event("input", { bubbles: true }));
  $("hpfHz").dispatchEvent(new Event("change", { bubbles: true }));
}

function normalizePeakTargetDb(value) {
  if (String(value).trim().toLowerCase() === "off") return "off";
  const numeric = Number(value);
  return [-3, -6].includes(numeric) ? numeric : -3;
}

function syncPeakGuardButtons() {
  const current = normalizePeakTargetDb($("peakTargetDb")?.value);
  document.querySelectorAll("[data-peak-target-db]").forEach((button) => {
    const target = normalizePeakTargetDb(button.dataset.peakTargetDb);
    const active = target === current;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setPeakGuardPreset(value) {
  $("peakTargetDb").value = String(normalizePeakTargetDb(value));
  $("peakTargetDb").dispatchEvent(new Event("input", { bubbles: true }));
  $("peakTargetDb").dispatchEvent(new Event("change", { bubbles: true }));
}

function normalizeDeepFilterMode(value) {
  const normalized = String(value || "off").trim().toLowerCase();
  return ["off", "light", "strong"].includes(normalized) ? normalized : "off";
}

function syncDeepFilterButtons() {
  const current = normalizeDeepFilterMode($("deepFilterMode")?.value);
  document.querySelectorAll("[data-deep-filter-mode]").forEach((button) => {
    const active = normalizeDeepFilterMode(button.dataset.deepFilterMode) === current;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setDeepFilterMode(value) {
  $("deepFilterMode").value = normalizeDeepFilterMode(value);
  $("deepFilterMode").dispatchEvent(new Event("input", { bubbles: true }));
  $("deepFilterMode").dispatchEvent(new Event("change", { bubbles: true }));
}

function updatePayloadPreview() {
  const code = document.querySelector(".code-card code");
  if (!code) return;
  try {
    const settings = readSettings();
    code.textContent = JSON.stringify(
      {
        endpoint: settings.endpoint,
        ...buildSpeechPayload(settings),
      },
      null,
      2,
    );
  } catch (error) {
    code.textContent = error instanceof Error ? error.message : String(error);
  }
}

function setScriptLength(nextLength) {
  scriptLength = ["short", "medium", "long"].includes(nextLength) ? nextLength : "short";
  document.querySelectorAll("[data-script-length]").forEach((button) => {
    const isActive = button.dataset.scriptLength === scriptLength;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
  saveSettings(readSettings());
}

function labEndpoint(endpoint, labPath) {
  const url = new URL(endpoint);
  const cleanPath = url.pathname.replace(/\/$/, "");
  url.pathname = cleanPath.endsWith("/v1")
    ? `${cleanPath}/lab/${labPath}`
    : `${cleanPath || ""}/v1/lab/${labPath}`;
  return url.toString();
}

function scriptwriterEndpoint(endpoint) {
  return labEndpoint(endpoint, "script");
}

function transientCacheEndpoint(endpoint) {
  return labEndpoint(endpoint, "cache");
}

function labSessionEndpoint(endpoint) {
  return labEndpoint(endpoint, "session");
}

function wait(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function isTransientFetchError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch|networkerror|load failed|aborterror|timeout|timed out/i.test(message);
}

async function keepDraftAnimationVisible(startedAt, minimumMs = 700) {
  const remaining = minimumMs - (Date.now() - startedAt);
  if (remaining > 0) await wait(remaining);
}

function setScriptDraftState(state, detail = "") {
  const panel = document.querySelector(".scriptwriter-panel");
  const button = $("draftLine");
  const status = $("scriptDraftStatus");
  const statusText = $("scriptDraftStatusText");
  panel?.classList.toggle("is-generating", state === "generating");
  panel?.classList.toggle("is-ready", state === "ready" || state === "fallback");
  panel?.classList.toggle("is-error", state === "error");
  button.classList.toggle("is-busy", state === "generating");
  button.setAttribute("aria-busy", String(state === "generating"));
  if (!status || !statusText) return;
  status.hidden = state === "idle";
  status.dataset.state = state;
  const label =
    state === "generating"
      ? "WRITING"
      : state === "fallback"
        ? "LOCAL LINE"
        : state === "error"
          ? "ERROR"
          : state === "ready"
            ? "LINE READY"
            : "";
  statusText.textContent = detail ? `${label} / ${detail}` : label;
}

async function draftScriptLine() {
  const scenario = $("scriptCue").value.trim();
  if (!scenario) {
    log("場面を入力してください。");
    return;
  }
  const startedAt = Date.now();
  $("draftLine").disabled = true;
  $("draftLine").textContent = "生成中";
  setScriptDraftState("generating");
  try {
    const response = await fetch(scriptwriterEndpoint($("endpoint").value), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...($("apiKey").value ? { Authorization: `Bearer ${$("apiKey").value}` } : {}),
      },
      body: JSON.stringify({
        scenario,
        length: scriptLength,
        variant: crypto.randomUUID(),
        temperature: 0.95,
        top_p: 0.95,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
      throw new Error(message);
    }
    const text = String(payload.text || "").trim();
    if (!text) throw new Error("セリフが空でした。");
    await keepDraftAnimationVisible(startedAt);
    $("text").value = text;
    updatePayloadPreview();
    saveSettings(readSettings());
    setScriptDraftState(payload.source === "local-fallback" ? "fallback" : "ready", payload.target || scriptLength);
    log(`セリフ生成: ${payload.target || scriptLength} / ${text}`);
    if (payload.warning) log(payload.warning);
  } catch (error) {
    await keepDraftAnimationVisible(startedAt);
    setScriptDraftState("error");
    log(error instanceof Error ? error.message : String(error));
    log("脚本生成LLMを使うには、GemmaなどのOpenAI互換LLMサーバーを起動してください。");
  } finally {
    $("draftLine").disabled = false;
    $("draftLine").textContent = "セリフ生成";
    $("draftLine").classList.remove("is-busy");
    $("draftLine").setAttribute("aria-busy", "false");
  }
}

function revokeAudioObjectUrls() {
  const urls = new Set([latestAudioUrl, latestBaseAudioUrl, latestPreviewAudioUrl].filter(Boolean));
  urls.forEach((url) => URL.revokeObjectURL(url));
  latestAudioUrl = "";
  latestBaseAudioUrl = "";
  latestPreviewAudioUrl = "";
}

function createLiveEqFilter(context, type, frequency, q = null) {
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  if (q !== null) filter.Q.value = q;
  return filter;
}

function setAudioParam(param, value, now) {
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, 0.004);
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function snapToStep(value, step) {
  if (!step || step === "any") return value;
  const numericStep = Number(step);
  if (!Number.isFinite(numericStep) || numericStep <= 0) return value;
  return Math.round(value / numericStep) * numericStep;
}

function syncEqFader(slider, fader) {
  const min = Number(slider.min);
  const max = Number(slider.max);
  const value = Number(slider.value);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(value) || max === min) return;
  const ratio = clampNumber((value - min) / (max - min), 0, 1);
  fader.style.setProperty("--eq-level", String(ratio));
  fader.setAttribute("aria-valuenow", value.toFixed(1));
}

function setVerticalSliderValueFromPointer(slider, fader, clientY) {
  const rect = fader.getBoundingClientRect();
  const min = Number(slider.min);
  const max = Number(slider.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || rect.height <= 0) return;
  const ratio = clampNumber((rect.bottom - clientY) / rect.height, 0, 1);
  const rawValue = min + (max - min) * ratio;
  const nextValue = clampNumber(snapToStep(rawValue, slider.step), min, max);
  slider.value = nextValue.toFixed(1);
  syncEqFader(slider, fader);
  slider.dispatchEvent(new Event("input", { bubbles: true }));
}

function installVerticalSliderDrag(slider) {
  const fader = document.createElement("div");
  fader.className = "eq-fader";
  fader.setAttribute("role", "slider");
  fader.setAttribute("tabindex", "0");
  fader.setAttribute("aria-label", slider.id);
  fader.setAttribute("aria-valuemin", slider.min);
  fader.setAttribute("aria-valuemax", slider.max);
  fader.innerHTML = `<span class="eq-fader-fill"></span><span class="eq-fader-thumb"></span>`;
  slider.after(fader);
  slider.classList.add("eq-slider-native");
  slider.syncEqFader = () => syncEqFader(slider, fader);
  slider.addEventListener("input", slider.syncEqFader);
  slider.addEventListener("change", slider.syncEqFader);
  syncEqFader(slider, fader);

  fader.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    fader.setPointerCapture?.(event.pointerId);
    setVerticalSliderValueFromPointer(slider, fader, event.clientY);
  });
  fader.addEventListener("pointermove", (event) => {
    if (!fader.hasPointerCapture?.(event.pointerId)) return;
    event.preventDefault();
    setVerticalSliderValueFromPointer(slider, fader, event.clientY);
  });
  fader.addEventListener("pointerup", (event) => {
    fader.releasePointerCapture?.(event.pointerId);
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  });
  fader.addEventListener("pointercancel", (event) => {
    fader.releasePointerCapture?.(event.pointerId);
  });
  fader.addEventListener("keydown", (event) => {
    const step = Number(slider.step) || 0.1;
    const min = Number(slider.min);
    const max = Number(slider.max);
    const current = Number(slider.value) || 0;
    const keySteps = {
      ArrowUp: 1,
      ArrowRight: 1,
      ArrowDown: -1,
      ArrowLeft: -1,
      PageUp: 5,
      PageDown: -5,
      Home: null,
      End: null,
    };
    if (!(event.key in keySteps)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? min
        : event.key === "End"
          ? max
          : clampNumber(current + keySteps[event.key] * step, min, max);
    slider.value = next.toFixed(1);
    syncEqFader(slider, fader);
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function liveSculptSignature(settings) {
  return [
    settings.speed,
    settings.pitch,
    settings.sculpt.hpfHz,
    settings.sculpt.gainDb,
    settings.sculpt.lowDb,
    settings.sculpt.midDb,
    settings.sculpt.highDb,
    settings.sculpt.presenceDb,
    settings.sculpt.airDb,
  ]
    .map((value) => Number(value || 0).toFixed(2))
    .join("|");
}

function applyLiveAudioSettings(settings = readSettings()) {
  const player = $("audioPlayer");
  const signature = liveSculptSignature(settings);
  if (lastLiveSculptSignature && signature !== lastLiveSculptSignature) sculptRenderDirty = true;
  lastLiveSculptSignature = signature;
  const playbackRate = livePlaybackRate(settings);
  player.playbackRate = playbackRate;
  player.dataset.liveSpeed = normalizePlaybackSpeed(settings.speed).toFixed(2);
  player.dataset.livePitch = Number(settings.pitch || 0).toFixed(1);
  player.dataset.livePlaybackRate = playbackRate.toFixed(3);
  player.dataset.liveEq = [
    settings.sculpt.hpfHz,
    settings.sculpt.gainDb,
    settings.sculpt.lowDb,
    settings.sculpt.midDb,
    settings.sculpt.highDb,
    settings.sculpt.presenceDb,
    settings.sculpt.airDb,
  ]
    .map((value) => Number(value || 0).toFixed(1))
    .join(",");
  player.dataset.liveGainScalar = (10 ** ((Number(settings.sculpt.gainDb) || 0) / 20)).toFixed(3);
  player.dataset.liveHpfHz = String(normalizeHpfHz(settings.sculpt.hpfHz));
  if (!liveAudioContext || !liveEqNodes) return;
  if (signature === lastAppliedLiveSculptSignature) return;
  lastAppliedLiveSculptSignature = signature;
  const now = liveAudioContext.currentTime;
  if (liveAudioSource) setAudioParam(liveAudioSource.playbackRate, playbackRate, now);
  setAudioParam(liveEqNodes.hpf.frequency, effectiveHpfFrequency(settings.sculpt.hpfHz), now);
  setAudioParam(liveEqNodes.low.gain, Number(settings.sculpt.lowDb) || 0, now);
  setAudioParam(liveEqNodes.mid.gain, Number(settings.sculpt.midDb) || 0, now);
  setAudioParam(liveEqNodes.high.gain, Number(settings.sculpt.highDb) || 0, now);
  setAudioParam(liveEqNodes.presence.gain, Number(settings.sculpt.presenceDb) || 0, now);
  setAudioParam(liveEqNodes.air.gain, Number(settings.sculpt.airDb) || 0, now);
  setAudioParam(liveEqNodes.gain.gain, 10 ** ((Number(settings.sculpt.gainDb) || 0) / 20), now);
}

function startLiveSettingsSync() {
  if (liveSettingsSyncFrame) return;
  const tick = () => {
    applyLiveAudioSettings();
    liveSettingsSyncFrame = globalThis.requestAnimationFrame(tick);
  };
  liveSettingsSyncFrame = globalThis.requestAnimationFrame(tick);
}

function stopLiveSettingsSync() {
  if (!liveSettingsSyncFrame) return;
  globalThis.cancelAnimationFrame(liveSettingsSyncFrame);
  liveSettingsSyncFrame = 0;
}

async function resumeLiveAudioContext(player, timeoutMs = 350) {
  if (!liveAudioContext || liveAudioContext.state !== "suspended") return;
  const resumePromise = liveAudioContext
    .resume()
    .then(() => {
      player.dataset.audioContextState = liveAudioContext?.state || "closed";
    })
    .catch((error) => log(error instanceof Error ? error.message : String(error)));
  await Promise.race([resumePromise, wait(timeoutMs)]);
  player.dataset.audioContextState = liveAudioContext?.state || "closed";
}

async function startLiveAudioRouting() {
  const player = $("audioPlayer");
  if (!liveAudioContext) {
    const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextCtor) throw new Error("このブラウザではライブEQを使用できません。");
    const context = new AudioContextCtor();
    const hpf = createLiveEqFilter(context, "highpass", 10, 0.707);
    const low = createLiveEqFilter(context, "lowshelf", 180);
    const mid = createLiveEqFilter(context, "peaking", 900, 0.85);
    const high = createLiveEqFilter(context, "highshelf", 3200);
    const presence = createLiveEqFilter(context, "peaking", 4800, 1.2);
    const air = createLiveEqFilter(context, "highshelf", 9000);
    const gain = context.createGain();
    hpf.connect(low).connect(mid).connect(high).connect(presence).connect(air).connect(gain).connect(context.destination);
    liveAudioContext = context;
    liveEqNodes = { hpf, low, mid, high, presence, air, gain };
  }
  applyLiveAudioSettings();
  startLiveSettingsSync();
  player.dataset.eqRouting = "live";
  player.dataset.audioContextState = liveAudioContext.state;
  await resumeLiveAudioContext(player);
}

async function ensureSourceAudioBuffer() {
  if (!latestSourceAudioBlob) throw new Error(SOURCE_REQUIRED_MESSAGE);
  if (!latestSourceAudioBuffer) latestSourceAudioBuffer = await decodeBlob(latestSourceAudioBlob);
  return latestSourceAudioBuffer;
}

function stopLiveAudioSource() {
  if (!liveAudioSource) return;
  try {
    liveAudioSource.stop(0);
  } catch {
    // The one-shot source may have already ended.
  }
  liveAudioSource.disconnect();
  liveAudioSource = null;
}

function syncPlaybackButtonState() {
  const button = $("playPreview");
  if (!button) return;
  button.disabled = !latestSourceAudioBlob;
  const player = $("audioPlayer");
  const isPlaying = Boolean(liveAudioSource) || (player && !player.paused && !player.ended);
  button.textContent = isPlaying ? "停止" : "再生";
}

function resetPlayerToStart(player, force = false) {
  if (!player) return;
  const duration = Number(player.duration);
  const endedAtTail =
    Number.isFinite(duration) &&
    duration > 0 &&
    player.currentTime >= player.duration - 0.05;
  if (!force && !player.ended && !endedAtTail) return;
  try {
    player.currentTime = 0;
  } catch {
    // Some browsers reject seeking before metadata is available.
  }
}

function startLiveAudioSource(buffer) {
  if (!liveAudioContext || !liveEqNodes) return;
  stopLiveAudioSource();
  const source = liveAudioContext.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = livePlaybackRate();
  source.connect(liveEqNodes.hpf);
  source.onended = () => {
    if (liveAudioSource === source) {
      liveAudioSource = null;
      $("audioPlayer").dataset.livePlayback = "ended";
      syncPlaybackButtonState();
    }
  };
  liveAudioSource = source;
  $("audioPlayer").dataset.livePlayback = "playing";
  syncPlaybackButtonState();
  source.start(0);
}

async function playNativeAudioFallback(reason = "", options = {}) {
  const player = $("audioPlayer");
  const baseAudioUrl = ensureBaseAudioUrl();
  if (!baseAudioUrl) {
    log(SOURCE_REQUIRED_MESSAGE);
    return;
  }
  stopLiveAudioSource();
  player.src = baseAudioUrl;
  player.load();
  resetPlayerToStart(player);
  player.playbackRate = options.raw ? 1 : livePlaybackRate();
  player.dataset.livePlayback = "native";
  player.dataset.eqRouting = options.raw ? "native-raw" : "native-fallback";
  if (reason) log(`${reason} 通常再生に戻しました。`);
  await player.play();
  syncPlaybackButtonState();
}

function suspendLiveAudioRouting() {
  stopLiveAudioSource();
  stopLiveSettingsSync();
  if (liveAudioContext?.state === "running") void liveAudioContext.suspend().catch(() => {});
  syncPlaybackButtonState();
}

function closeLiveAudioRouting() {
  stopLiveAudioSource();
  stopLiveSettingsSync();
  Object.values(liveEqNodes || {}).forEach((node) => node.disconnect());
  const context = liveAudioContext;
  liveAudioContext = null;
  liveAudioSource = null;
  liveEqNodes = null;
  lastLiveSculptSignature = "";
  lastAppliedLiveSculptSignature = "";
  if (context && context.state !== "closed") void context.close().catch(() => {});
}

function setBaseAudioBlob(blob, sourceKind = "generated") {
  const player = $("audioPlayer");
  player.pause();
  suspendLiveAudioRouting();
  revokeAudioObjectUrls();
  latestSourceAudioBlob = blob;
  latestSourceKind = sourceKind;
  latestSourceAudioBuffer = null;
  latestAudioBlob = blob;
  sculptRenderDirty = true;
  lastLiveSculptSignature = "";
  lastAppliedLiveSculptSignature = "";
  latestBaseAudioUrl = URL.createObjectURL(blob);
  latestAudioUrl = latestBaseAudioUrl;
  player.src = latestBaseAudioUrl;
  player.load();
  resetPlayerToStart(player, true);
  player.dataset.audioMode = "buffer-live";
  player.dataset.livePlayback = "idle";
  applyLiveAudioSettings();
  syncPlaybackButtonState();
}

function ensureBaseAudioUrl() {
  if (!latestSourceAudioBlob) return "";
  if (!latestBaseAudioUrl) latestBaseAudioUrl = URL.createObjectURL(latestSourceAudioBlob);
  return latestBaseAudioUrl;
}

async function playCurrentAudio({ refreshAnalysis = true } = {}) {
  const player = $("audioPlayer");
  const baseAudioUrl = ensureBaseAudioUrl();
  if (!baseAudioUrl) {
    log(SOURCE_REQUIRED_MESSAGE);
    return;
  }
  player.pause();
  stopLiveAudioSource();
  player.src = baseAudioUrl;
  latestAudioUrl = latestBaseAudioUrl;
  if (latestSourceKind === "final-artifact") {
    await playNativeAudioFallback("成果物テストは未加工で再生します。", { raw: true });
    if (refreshAnalysis) await drawAudioAnalysis(latestSourceAudioBlob).catch(() => {});
    return;
  }
  try {
    await startLiveAudioRouting();
    if (liveAudioContext?.state !== "running") {
      await playNativeAudioFallback("ライブEQを開始できませんでした。");
      if (refreshAnalysis) await drawAudioAnalysis(latestSourceAudioBlob).catch(() => {});
      return;
    }
    const sourceBuffer = await ensureSourceAudioBuffer();
    startLiveAudioSource(sourceBuffer);
    if (refreshAnalysis) await drawAudioAnalysis(latestSourceAudioBlob).catch(() => {});
    log("ライブEQで再生します。再生中にスライダーを動かすと音へ反映されます。");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await playNativeAudioFallback(`ライブEQエラー: ${message}`);
    } catch (fallbackError) {
      log(fallbackError instanceof Error ? fallbackError.message : String(fallbackError));
    }
  }
}

function resetCurrentPreviewForGeneration() {
  const player = $("audioPlayer");
  player.pause();
  stopLiveAudioSource();
  player.removeAttribute("src");
  player.srcObject = null;
  player.load();
  suspendLiveAudioRouting();
  revokeAudioObjectUrls();
  latestAudioBlob = null;
  latestSourceAudioBlob = null;
  latestSourceAudioBuffer = null;
  latestSourceKind = "";
  latestCard = null;
  latestPreviewAudioUrl = "";
  sculptRenderDirty = false;
  player.dataset.audioMode = "empty";
  player.dataset.livePlayback = "idle";
  player.dataset.eqRouting = "off";
  syncPlaybackButtonState();
  clearAnalysisCanvas($("waveformCanvas"));
  clearAnalysisCanvas($("histogramCanvas"));
}

function clearAnalysisCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#02080b";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(99,246,255,.08)";
  ctx.lineWidth = 1;
  for (let x = 0; x < canvas.width; x += 48) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
}

function releaseTransientAudio({ quiet = false } = {}) {
  const player = $("audioPlayer");
  player.pause();
  player.removeAttribute("src");
  player.load();
  suspendLiveAudioRouting();
  revokeAudioObjectUrls();
  latestAudioBlob = null;
  latestSourceAudioBlob = null;
  latestSourceAudioBuffer = null;
  latestSourceKind = "";
  latestCard = null;
  sculptRenderDirty = false;
  syncPlaybackButtonState();
  clearAnalysisCanvas($("waveformCanvas"));
  clearAnalysisCanvas($("histogramCanvas"));
  if (!quiet) log("一時音声をメモリからクリアしました。保存済みカードと参照音声は残しています。");
}

async function clearTransientAudio() {
  $("clearTransientAudio").disabled = true;
  try {
    releaseTransientAudio();
    const payload = await deleteServerTransientCache($("endpoint").value);
    log(`サーバー一時音声を削除しました: ${payload.deleted || 0}件 / ${Math.round((payload.bytes || 0) / 1024)}KB`);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
  } finally {
    $("clearTransientAudio").disabled = false;
  }
}

async function deleteServerTransientCache(endpoint) {
  const response = await fetch(transientCacheEndpoint(endpoint), { method: "DELETE" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

async function prepareTextGenerationWorkspace(settings) {
  const hadLocalAudio = Boolean(latestSourceAudioBlob || latestAudioBlob || latestBaseAudioUrl || latestPreviewAudioUrl);
  const hadPendingReference = Boolean(referenceFile);
  resetCurrentPreviewForGeneration();
  clearPendingReferenceFile();
  if (hadPendingReference && settings.voice === "none") {
    log("生成前に未確定の一時音声参照を解除しました。");
  }
  try {
    const payload = await deleteServerTransientCache(settings.endpoint);
    if (hadLocalAudio || Number(payload.deleted || 0) > 0) {
      log(`生成前に一時音声をクリアしました: ${payload.deleted || 0}件 / ${Math.round((payload.bytes || 0) / 1024)}KB`);
    }
  } catch (error) {
    log(`生成前キャッシュ削除はスキップしました: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function cleanupTransientAudioOnClose() {
  releaseTransientAudio({ quiet: true });
  revokeExpressionAudioUrls();
  closeLiveAudioRouting();
  try {
    void fetch(labSessionEndpoint($("endpoint").value), {
      method: "DELETE",
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Page teardown may interrupt this request; generated files are deleted per request.
  }
}

function resetSculptControls() {
  $("speed").value = 1;
  $("pitch").value = 0;
  $("hpfHz").value = 0;
  $("peakTargetDb").value = -3;
  $("deepFilterMode").value = "off";
  ["gainDb", "lowDb", "midDb", "highDb", "presenceDb", "airDb"].forEach((id) => {
    $(id).value = 0;
  });
  updateSliderLabels();
  updatePayloadPreview();
  sculptRenderDirty = true;
  applyLiveAudioSettings();
  log("Speed、Pitch、EQをリセットしました。再生中なら音へすぐ反映されます。");
}

function resetTextGenerationDefaults() {
  clearPendingReferenceFile();
  $("model").value = DEFAULT_MODEL;
  $("format").value = "wav";
  $("voiceCaption").value = DEFAULT_VOICE_CAPTION;
  $("seed").value = "";
  $("seedQuick").value = "";
  if ($("expressionSourceMode")) $("expressionSourceMode").value = DEFAULT_EXPRESSION_SOURCE_MODE;
  expressionSeedBase = "";
  $("speed").value = 1;
  $("pitch").value = 0;
  $("sway").value = -1;
  $("schedule").value = "linear";
  $("cfgMode").value = "independent";
  seedQuality = "standard";
  const preset = seedQualityPreset(seedQuality);
  $("numSteps").value = preset.steps;
  $("cfgText").value = preset.cfgText;
  $("cfgCaption").value = preset.cfgCaption;
  $("cfgSpeaker").value = preset.cfgSpeaker;
  $("hpfHz").value = 0;
  $("peakTargetDb").value = "off";
  $("deepFilterMode").value = "off";
  ["gainDb", "lowDb", "midDb", "highDb", "presenceDb", "airDb"].forEach((id) => {
    $(id).value = 0;
  });
  selectDerivedReference("none");
  syncSeedQualityButtons();
  syncHpfButtons();
  syncPeakGuardButtons();
  syncDeepFilterButtons();
  updateSliderLabels();
  updatePayloadPreview();
  sculptRenderDirty = true;
  applyLiveAudioSettings();
  saveSettings(readSettings());
  log("標準に戻しました: 参照なし / Seedランダム / CFG標準 / 後処理Off");
}

function log(message) {
  const now = new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  $("logPanel").textContent = `[${now}] ${message}\n${$("logPanel").textContent}`;
}

function expressionStatusLabel(status) {
  return EXPRESSION_STATUS[status] || status || EXPRESSION_STATUS.queued;
}

function expressionCategoryById(id) {
  const categories = [
    ...currentExpressionCategories(),
    ...(countsByCategory.has("custom") ? [{ id: "custom", label: "自作表現", target: 0 }] : []),
  ];
  return categories.find((category) => category.id === id) || categories[0];
}

function readExpressionLimit() {
  const input = $("expressionLimit");
  const value = Number(input?.value);
  return Number.isFinite(value) ? clampNumber(Math.round(value), 8, 160) : 145;
}

function setExpressionLimit(value) {
  const limit = clampNumber(Math.round(Number(value) || 145), 8, 160);
  const input = $("expressionLimit");
  if (input) input.value = String(limit);
  document.querySelectorAll("[data-expression-limit]").forEach((button) => {
    const isActive = Number(button.dataset.expressionLimit) === limit;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function expressionCounts() {
  const counts = {
    total: expressionQueue.length,
    queued: 0,
    generated: 0,
    accepted: 0,
    soundOnly: 0,
    hold: 0,
    recording: 0,
    rejected: 0,
    hasAudio: 0,
  };
  expressionQueue.forEach((item) => {
    counts[item.status] = (counts[item.status] || 0) + 1;
    if (item.hasAudio) counts.hasAudio += 1;
  });
  return counts;
}

function acceptedExpressionItems() {
  return expressionQueue.filter((item) => ["accepted", "soundOnly"].includes(item.status) && item.hasAudio);
}

function speakerMaterialProfileConfig() {
  const id = $("speakerMaterialProfile")?.value || "all";
  return SPEAKER_MATERIAL_PROFILES[id] || SPEAKER_MATERIAL_PROFILES.all;
}

function speakerMaterialItems(profile = speakerMaterialProfileConfig()) {
  const items = acceptedExpressionItems();
  if (profile.id === "all") return items;
  return items.filter((item) => {
    if (profile.acceptedOnly && item.status !== "accepted") return false;
    if (profile.categories && !profile.categories.has(item.category)) return false;
    return true;
  });
}

function plannedGeneralSpeechCount() {
  if (!includeGeneralSpeechSetInFinal()) return 0;
  return Math.max(generalSpeechMaterialItems().length, GENERAL_SPEECH_TARGET_COUNT);
}

function recommendedSpeakerBuildSteps(sampleCount) {
  const count = Math.max(0, Number(sampleCount) || 0);
  if (count <= 0) return 800;
  return Math.max(800, Math.ceil((sampleCount * 16) / 100) * 100);
}

function updateSpeakerMaterialProfileHint() {
  const hint = $("speakerMaterialProfileHint");
  if (!hint) return;
  const profile = speakerMaterialProfileConfig();
  const expressionCount = speakerMaterialItems(profile).length;
  const generatedGeneralCount = generalSpeechMaterialItems().length;
  const plannedGeneralCount = plannedGeneralSpeechCount();
  const generalLabel = includeGeneralSpeechSetInFinal()
    ? `一般音声 ${generatedGeneralCount}/${GENERAL_SPEECH_TARGET_COUNT}件を含める`
    : "一般音声は含めない";
  const stepHint = plannedGeneralCount > 0
    ? ` / 標準は素材数に応じて内部stepを調整します。${SPEAKER_STEP_HINT_GENERAL}`
    : " / 標準は素材数に応じて内部stepを調整します";
  hint.textContent = `${profile.label}: ${profile.description} / 表現音 ${expressionCount}件 / ${generalLabel}${stepHint}`;
}

function expressionSeedForItem(baseSeed, index) {
  const numericBase = Number(baseSeed);
  if (Number.isFinite(numericBase) && baseSeed !== "") return String(numericBase + index + 1);
  const random = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000_000;
  return String(random + index);
}

function expressionSourceMode() {
  const value = String($("expressionSourceMode")?.value || DEFAULT_EXPRESSION_SOURCE_MODE);
  return value === "reference" ? "reference" : DEFAULT_EXPRESSION_SOURCE_MODE;
}

function expressionSourceModeLabel(mode = expressionSourceMode()) {
  return mode === "reference" ? "参照音声を使う" : "VoiceDesign直接";
}

function expressionSourceModeHint(mode = expressionSourceMode()) {
  return mode === "reference"
    ? "参照音声を使って表現音を生成します。比較用の旧ルートです。"
    : "参照音声を使わず、声の説明と固定Seedから直接表現音を生成します。";
}

function ensureExpressionSeedBase() {
  const seed = String($("seed")?.value || "").trim();
  if (seed) {
    expressionSeedBase = seed;
    return expressionSeedBase;
  }
  if (!expressionSeedBase) {
    expressionSeedBase = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000_000);
  }
  return expressionSeedBase;
}

function expressionItemFilename(item) {
  const order = String(item.order + 1).padStart(3, "0");
  return `${order}-${safeFilename(item.categoryLabel)}-${safeFilename(item.text).slice(0, 32)}.wav`;
}

function buildExpressionSettings(item) {
  const settings = readSettings();
  const baseCaption = item.voiceCaption?.trim() || settings.voiceCaption?.trim() || DEFAULT_VOICE_CAPTION;
  const sourceMode = expressionSourceMode();
  return {
    ...settings,
    voice: sourceMode === "direct" ? "none" : settings.voice,
    text: item.text,
    caption: `${baseCaption}\n${item.caption}`,
    voiceCaption: `${baseCaption}\n${item.caption}`,
    expressionSourceMode: sourceMode,
    seed: item.seed || expressionSeedForItem(settings.seed || ensureExpressionSeedBase(), item.order),
  };
}

function revokeGeneralSpeechAudioUrls() {
  generalSpeechItems.forEach((item) => {
    if (item.audioUrl) URL.revokeObjectURL(item.audioUrl);
    item.audioUrl = "";
  });
  generalSpeechAudioBlobs.clear();
}

function buildGeneralSpeechQueueItems(limit = GENERAL_SPEECH_TARGET_COUNT) {
  const baseSettings = readSettings();
  const voiceGender = currentExpressionGender();
  const voiceCaption = baseSettings.voiceCaption?.trim() || DEFAULT_VOICE_CAPTION;
  const targetTotal = GENERAL_SPEECH_CATEGORIES.reduce((sum, category) => sum + category.target, 0);
  const quotas = GENERAL_SPEECH_CATEGORIES.map((category) => {
    const exact = targetTotal > 0 ? (category.target / targetTotal) * limit : 0;
    return {
      category,
      quota: Math.floor(exact),
      remainder: exact - Math.floor(exact),
      used: 0,
    };
  });
  let assigned = quotas.reduce((sum, quota) => sum + quota.quota, 0);
  quotas
    .slice()
    .sort((a, b) => b.remainder - a.remainder)
    .forEach((quota) => {
      if (assigned >= limit) return;
      quota.quota += 1;
      assigned += 1;
    });
  const items = [];
  while (items.length < limit && quotas.some((quota) => quota.used < quota.quota)) {
    for (const quota of quotas) {
      if (items.length >= limit) break;
      if (quota.used >= quota.quota) continue;
      const category = quota.category;
      const line = category.lines[quota.used % category.lines.length];
      quota.used += 1;
      items.push({
        id: crypto.randomUUID(),
        sourceKind: "general",
        order: items.length,
        voiceGender,
        voiceCaption,
        category: `general_${category.id}`,
        categoryLabel: `一般音声:${category.label}`,
        text: line,
        caption: category.caption,
        status: "accepted",
        hasAudio: false,
        audioUrl: "",
        elapsedMs: null,
        generatedAt: "",
        seed: "",
        error: "",
      });
    }
  }
  return items;
}

function ensureGeneralSpeechQueue() {
  if (!generalSpeechItems.length) {
    generalSpeechItems = buildGeneralSpeechQueueItems();
  }
  return generalSpeechItems;
}

function generalSpeechCounts() {
  const total = generalSpeechItems.length || GENERAL_SPEECH_TARGET_COUNT;
  const generated = generalSpeechItems.filter((item) => item.hasAudio && generalSpeechAudioBlobs.has(item.id)).length;
  const failed = generalSpeechItems.filter((item) => item.error).length;
  return { total, generated, failed, remaining: Math.max(0, total - generated) };
}

function renderGeneralSpeechStatus(message = "") {
  const counts = generalSpeechCounts();
  const status = $("generalSpeechStatus");
  const progress = $("generalSpeechProgress");
  if (progress) {
    progress.max = String(GENERAL_SPEECH_TARGET_COUNT);
    progress.value = String(counts.generated);
  }
  if (status) {
    status.textContent =
      message ||
      `一般音声: ${counts.generated}/${GENERAL_SPEECH_TARGET_COUNT} 生成済み${counts.failed ? ` / エラー ${counts.failed}` : ""}。含めるがオンなら最終成果物に合算します。`;
  }
  updateSpeakerMaterialProfileHint();
}

function generalSpeechItemFilename(item) {
  const order = String(item.order + 1).padStart(3, "0");
  return `general-${order}-${safeFilename(item.categoryLabel)}-${safeFilename(item.text).slice(0, 28)}.wav`;
}

function materialItemFilename(item) {
  return item.sourceKind === "general" ? generalSpeechItemFilename(item) : expressionItemFilename(item);
}

function materialAudioBlob(item) {
  return item.sourceKind === "general" ? generalSpeechAudioBlobs.get(item.id) : expressionAudioBlobs.get(item.id);
}

function buildGeneralSpeechSettings(item) {
  const settings = readSettings();
  const baseCaption = item.voiceCaption?.trim() || settings.voiceCaption?.trim() || DEFAULT_VOICE_CAPTION;
  return {
    ...settings,
    text: item.text,
    caption: `${baseCaption}\n${item.caption}\n普通の読み上げ素材として、声質の癖を強くしすぎず、発音を安定させる。`,
    voiceCaption: `${baseCaption}\n${item.caption}`,
    seed: expressionSeedForItem(settings.seed, item.order + 1000),
  };
}

function clearPendingMaterialReference(settings) {
  const hadPendingReference = Boolean(referenceFile);
  clearPendingReferenceFile();
  if (hadPendingReference && settings.voice === "none") {
    log("素材生成前に未確定の一時音声参照を解除しました。保存済み参照音声だけを使います。");
  }
}

function includeGeneralSpeechSetInFinal() {
  return Boolean($("includeGeneralSpeechSet")?.checked);
}

function generalSpeechMaterialItems() {
  return generalSpeechItems.filter((item) => item.hasAudio && generalSpeechAudioBlobs.has(item.id));
}

function speakerBuildItems(profile = speakerMaterialProfileConfig()) {
  const items = [...speakerMaterialItems(profile)];
  if (includeGeneralSpeechSetInFinal()) items.push(...generalSpeechMaterialItems());
  return items;
}

function setGeneralSpeechControlsRunning(running) {
  generalSpeechBatchRunning = running;
  const generateButton = $("generateGeneralSpeechSet");
  const clearButton = $("clearGeneralSpeechSet");
  if (generateButton) {
    generateButton.disabled = running;
    generateButton.textContent = running ? "一般音声を生成中..." : "一般音声100を生成";
  }
  if (clearButton) clearButton.disabled = running;
}

async function generateGeneralSpeechItemOnce(item) {
  const settings = buildGeneralSpeechSettings(item);
  let failed = false;
  item.error = "";
  item.seed = settings.seed;
  resetCurrentPreviewForGeneration();
  clearPendingMaterialReference(settings);
  renderGeneralSpeechStatus(`一般音声 ${String(item.order + 1).padStart(3, "0")}/${GENERAL_SPEECH_TARGET_COUNT} を生成中...`);
  $("serverStatus").textContent = "生成中";
  try {
    if (shouldUploadReference(settings)) {
      const voiceId = voiceIdFromFilename(referenceFile.name);
      const uploaded = await uploadReferenceVoice(settings.endpoint, referenceFile, voiceId, settings.apiKey);
      $("voice").value = uploaded.voice_id || voiceId;
      settings.voice = $("voice").value;
      clearPendingReferenceFile();
      log(`参照音声を登録しました: ${settings.voice}`);
    }
    const result = await synthesizeSpeech(settings);
    const processed = await renderExpressionOutputAudio(result.blob, settings);
    generalSpeechAudioBlobs.set(item.id, processed.blob);
    if (item.audioUrl) URL.revokeObjectURL(item.audioUrl);
    item.audioUrl = URL.createObjectURL(processed.blob);
    item.hasAudio = true;
    item.elapsedMs = result.elapsedMs;
    item.generatedAt = new Date().toISOString();
    setBaseAudioBlob(processed.blob, "general");
    latestCard = buildCard(settings, processed.blob, {
      name: generalSpeechItemFilename(item).replace(/\.wav$/, ""),
      elapsedMs: result.elapsedMs,
    });
    await drawAudioAnalysis(processed.blob);
    $("serverStatus").textContent = `${result.elapsedMs}ms`;
    if (processed.notes.length) log(`一般音声後処理: ${processed.notes.join(" / ")}`);
    log(`一般音声生成: ${String(item.order + 1).padStart(3, "0")} ${item.categoryLabel} / ${result.elapsedMs}ms`);
    return item;
  } catch (error) {
    failed = true;
    item.error = error instanceof Error ? error.message : String(error);
    $("serverStatus").textContent = "生成エラー";
    renderGeneralSpeechStatus(`一般音声生成エラー: ${item.error}`);
    log(item.error);
    throw error;
  } finally {
    if (!failed) renderGeneralSpeechStatus();
  }
}

async function generateGeneralSpeechItem(item) {
  let lastError = null;
  for (let attempt = 0; attempt <= GENERAL_SPEECH_MAX_RETRIES; attempt += 1) {
    try {
      return await generateGeneralSpeechItemOnce(item);
    } catch (error) {
      lastError = error;
      if (!isTransientFetchError(error) || attempt >= GENERAL_SPEECH_MAX_RETRIES) {
        throw error;
      }
      const delayMs = GENERAL_SPEECH_RETRY_DELAYS_MS[attempt] || GENERAL_SPEECH_RETRY_DELAYS_MS.at(-1) || 1000;
      const retryLabel = `${attempt + 1}/${GENERAL_SPEECH_MAX_RETRIES}`;
      renderGeneralSpeechStatus(`一般音声通信リトライ ${retryLabel}: ${String(item.order + 1).padStart(3, "0")} を再試行します...`);
      log(`一般音声通信リトライ ${retryLabel}: ${String(item.order + 1).padStart(3, "0")} ${item.error || error}`);
      await wait(delayMs);
    }
  }
  throw lastError || new Error("一般音声生成に失敗しました。");
}

async function ensureGeneralSpeechSetGenerated({ force = false } = {}) {
  if (generalSpeechBatchRunning) {
    log("一般音声100はすでに生成中です。");
    return generalSpeechMaterialItems();
  }
  ensureGeneralSpeechQueue();
  if (force) {
    revokeGeneralSpeechAudioUrls();
    generalSpeechItems = buildGeneralSpeechQueueItems();
  }
  setGeneralSpeechControlsRunning(true);
  try {
    let generated = 0;
    let failures = 0;
    let consecutiveFailures = 0;
    for (const item of generalSpeechItems) {
      if (item.hasAudio && generalSpeechAudioBlobs.has(item.id)) continue;
      try {
        await generateGeneralSpeechItem(item);
        generated += 1;
        consecutiveFailures = 0;
      } catch (error) {
        failures += 1;
        consecutiveFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        item.error = message;
        renderGeneralSpeechStatus(`一般音声: ${generalSpeechMaterialItems().length}/${GENERAL_SPEECH_TARGET_COUNT} 生成済み / エラー ${failures}。失敗候補を飛ばして続行します。`);
        log(`一般音声をスキップ: ${String(item.order + 1).padStart(3, "0")} ${message}`);
        if (consecutiveFailures >= 3) {
          renderGeneralSpeechStatus(`一般音声の連続エラーで停止しました。生成済み ${generalSpeechMaterialItems().length}/${GENERAL_SPEECH_TARGET_COUNT} / エラー ${failures}`);
          log("一般音声の連続エラーで停止しました。bridgeの状態を確認してから再実行してください。");
          break;
        }
      }
      await wait(80);
    }
    renderGeneralSpeechStatus(`一般音声: ${generalSpeechMaterialItems().length}/${GENERAL_SPEECH_TARGET_COUNT} 生成済み${failures ? ` / エラー ${failures}` : ""}。最終成果物へ合算できます。`);
    log(`一般音声100の生成を終了しました: 新規 ${generated}件 / 合計 ${generalSpeechMaterialItems().length}件 / エラー ${failures}件。`);
    return generalSpeechMaterialItems();
  } finally {
    setGeneralSpeechControlsRunning(false);
  }
}

function clearGeneralSpeechSet() {
  if (generalSpeechBatchRunning) {
    log("一般音声生成中はクリアできません。");
    return;
  }
  revokeGeneralSpeechAudioUrls();
  generalSpeechItems = [];
  if (latestSourceKind === "general") resetCurrentPreviewForGeneration();
  renderGeneralSpeechStatus("一般音声: 0/100 未生成。最終成果物作成時に自動生成できます。");
  log("一般音声100をクリアしました。");
}

function revokeExpressionAudioUrls() {
  expressionQueue.forEach((item) => {
    if (item.audioUrl) URL.revokeObjectURL(item.audioUrl);
    item.audioUrl = "";
  });
  expressionAudioBlobs.clear();
}

function buildExpressionQueueItems(limit = readExpressionLimit(), { startOrder = 0 } = {}) {
  const baseSettings = readSettings();
  const voiceGender = currentExpressionGender();
  const voiceCaption = baseSettings.voiceCaption?.trim() || DEFAULT_VOICE_CAPTION;
  const seedBase = ensureExpressionSeedBase();
  const categories = currentExpressionCategories();
  const fixedQuotaMap = new Map(
    categories
      .map((category) => [category.id, Number(category.fixedQuotas?.[limit]) || 0])
      .filter(([, quota]) => quota > 0),
  );
  const fixedTotal = Array.from(fixedQuotaMap.values()).reduce((sum, quota) => sum + quota, 0);
  const flexibleLimit = Math.max(0, limit - fixedTotal);
  const flexibleCategories = categories.filter((category) => !fixedQuotaMap.has(category.id));
  const targetTotal = flexibleCategories.reduce((sum, category) => sum + category.target, 0);
  const quotas = categories.map((category) => {
    const fixedQuota = fixedQuotaMap.get(category.id);
    if (fixedQuota) {
      return {
        category,
        quota: Math.min(limit, fixedQuota),
        remainder: 0,
        used: 0,
        fixed: true,
      };
    }
    const exact = targetTotal > 0 ? (category.target / targetTotal) * flexibleLimit : 0;
    return {
      category,
      quota: Math.floor(exact),
      remainder: exact - Math.floor(exact),
      used: 0,
      fixed: false,
    };
  });
  let assigned = quotas.reduce((sum, quota) => sum + quota.quota, 0);
  quotas
    .slice()
    .filter((quota) => !quota.fixed)
    .sort((a, b) => b.remainder - a.remainder)
    .forEach((quota) => {
      if (assigned >= limit) return;
      quota.quota += 1;
      assigned += 1;
    });
  const items = [];
  while (items.length < limit && quotas.some((quota) => quota.used < quota.quota)) {
    for (const quota of quotas) {
      if (items.length >= limit) break;
      if (quota.used >= quota.quota) continue;
      const category = quota.category;
      const line = category.lines[quota.used % category.lines.length];
      quota.used += 1;
      items.push({
        id: crypto.randomUUID(),
        order: startOrder + items.length,
        voiceGender,
        voiceCaption,
        category: category.id,
        categoryLabel: category.label,
        text: line,
        caption: category.caption,
        status: "queued",
        hasAudio: false,
        audioUrl: "",
        elapsedMs: null,
        generatedAt: "",
        seed: expressionSeedForItem(seedBase, startOrder + items.length),
        error: "",
      });
    }
  }
  return items;
}

function appendExpressionQueueItems(limit = readExpressionLimit()) {
  const startOrder = expressionQueue.length;
  const newItems = buildExpressionQueueItems(limit, { startOrder });
  expressionQueue.push(...newItems);
  if (!activeExpressionId) activeExpressionId = expressionQueue[0]?.id || newItems[0]?.id || "";
  renderExpressionWorkflow();
  return newItems;
}

function buildExpressionQueue() {
  if (expressionBatchRunning) {
    log("連続生成中は候補リストを作り直せません。先に停止してください。");
    return;
  }
  setExpressionLimit(readExpressionLimit());
  const beforeCount = expressionQueue.length;
  const newItems = appendExpressionQueueItems(readExpressionLimit());
  if (!activeExpressionId) activeExpressionId = newItems[0]?.id || "";
  $("expressionGenerationStatus").textContent =
    beforeCount > 0
      ? `${expressionGenderLabel()}セットの候補を追加しました: 追加 ${newItems.length}件 / 合計 ${expressionQueue.length}件。${expressionSourceModeLabel()} / ${expressionSourceModeHint()}`
      : `${expressionGenderLabel()}セットで${expressionQueue.length}件の候補を作成しました。${expressionSourceModeLabel()} / ${expressionSourceModeHint()}`;
  setLabTab("expression");
  log(
    beforeCount > 0
      ? `表現音候補を追加しました: ${expressionGenderLabel()} / ${expressionSourceModeLabel()} / 追加 ${newItems.length}件 / 合計 ${expressionQueue.length}件。`
      : `表現音候補を作成しました: ${expressionGenderLabel()} / ${expressionSourceModeLabel()} / ${expressionQueue.length}件。`,
  );
}

async function generateCustomExpressionCandidate() {
  if (expressionBatchRunning) {
    log("連続生成中は自作表現を追加できません。先に停止してください。");
    return;
  }
  const textarea = $("customExpressionText");
  const text = String(textarea?.value || "").trim();
  if (!text) {
    log("自作表現のテキストを入力してください。");
    return;
  }
  const voiceGender = currentExpressionGender();
  const voiceCaption = readSettings().voiceCaption?.trim() || DEFAULT_VOICE_CAPTION;
  const item = {
    id: crypto.randomUUID(),
    order: expressionQueue.length,
    voiceGender,
    voiceCaption,
    category: "custom",
    categoryLabel: "自作表現",
    text,
    caption: `${expressionGenderLabel(voiceGender)}声で、入力された表現を本文の勢いに合わせて演じる。声質は現在のVoice Designに合わせる。`,
    status: "queued",
    hasAudio: false,
    audioUrl: "",
    elapsedMs: null,
    generatedAt: "",
    seed: expressionSeedForItem(ensureExpressionSeedBase(), expressionQueue.length),
    error: "",
  };
  expressionQueue.push(item);
  activeExpressionId = item.id;
  renderExpressionWorkflow();
  setLabTab("expression");
  $("expressionGenerationStatus").textContent = `自作表現を生成中: ${text}`;
  await generateExpressionItem(item);
  setLabTab("review");
}

function resetExpressionQueue() {
  if (expressionBatchRunning) {
    expressionBatchRunning = false;
  }
  revokeExpressionAudioUrls();
  expressionQueue = [];
  activeExpressionId = "";
  expressionSeedBase = "";
  if (latestSourceKind === "expression") resetCurrentPreviewForGeneration();
  renderExpressionWorkflow();
  $("expressionGenerationStatus").textContent = "表現音セットをクリアしました。候補数を選んで作り直せます。";
  log("表現音セットをクリアしました。候補・生成済み音声・採用状態を空にしました。");
}

function renderExpressionWorkflow() {
  renderExpressionCategories();
  renderExpressionQueue();
  renderReviewQueue();
  renderReviewActive();
  renderExpressionStats();
}

function renderExpressionCategories() {
  const genderHint = $("expressionVoiceGenderHint");
  if (genderHint) genderHint.textContent = `現在の表現音: ${expressionGenderLabel()}セット`;
  const grid = $("expressionCategoryGrid");
  if (!grid) return;
  const countsByCategory = new Map();
  expressionQueue.forEach((item) => {
    const current = countsByCategory.get(item.category) || { total: 0, accepted: 0, generated: 0 };
    current.total += 1;
    if (item.hasAudio) current.generated += 1;
    if (["accepted", "soundOnly"].includes(item.status)) current.accepted += 1;
    countsByCategory.set(item.category, current);
  });
  const categories = currentExpressionCategories();
  grid.innerHTML = categories.map((category) => {
    const counts = countsByCategory.get(category.id) || { total: 0, accepted: 0, generated: 0 };
    return `
      <article class="expression-category-card">
        <span>${escapeHtml(category.label)}</span>
        <strong>${counts.accepted}/${counts.total}</strong>
        <small>generated ${counts.generated}</small>
      </article>
    `;
  }).join("");
}

function renderExpressionQueue() {
  const list = $("expressionQueueList");
  if (!list) return;
  if (!expressionQueue.length) {
    list.innerHTML = `<p class="hint">候補はまだありません。候補リスト作成から始めます。</p>`;
    return;
  }
  list.innerHTML = expressionQueue
    .map(
      (item) => `
        <button class="expression-row ${item.id === activeExpressionId ? "is-active" : ""}" type="button" data-expression-id="${item.id}">
          <span class="expression-row-order">${String(item.order + 1).padStart(3, "0")}</span>
          <span class="expression-row-main">
            <strong>${escapeHtml(item.text)}</strong>
            <small>${escapeHtml(item.categoryLabel)} / ${escapeHtml(expressionStatusLabel(item.status))}${item.elapsedMs ? ` / ${item.elapsedMs}ms` : ""}</small>
          </span>
          <span class="expression-row-status" data-status="${item.status}">${item.hasAudio ? "audio" : expressionStatusLabel(item.status)}</span>
        </button>
      `,
    )
    .join("");
  list.querySelectorAll("[data-expression-id]").forEach((button) => {
    button.addEventListener("click", () => selectExpressionItem(button.dataset.expressionId || ""));
  });
}

function renderReviewQueue() {
  const list = $("reviewQueueList");
  if (!list) return;
  const candidates = expressionQueue.filter((item) => item.hasAudio || item.status !== "queued");
  if (!candidates.length) {
    list.innerHTML = `<p class="hint">生成済み候補はまだありません。</p>`;
    return;
  }
  list.innerHTML = candidates
    .map(
      (item) => `
        <button class="review-row ${item.id === activeExpressionId ? "is-active" : ""}" type="button" data-expression-id="${item.id}">
          <span>${String(item.order + 1).padStart(3, "0")}</span>
          <strong>${escapeHtml(item.categoryLabel)}</strong>
          <small>${escapeHtml(item.text)}</small>
          <em data-status="${item.status}">${escapeHtml(expressionStatusLabel(item.status))}</em>
        </button>
      `,
    )
    .join("");
  list.querySelectorAll("[data-expression-id]").forEach((button) => {
    button.addEventListener("click", () => selectExpressionItem(button.dataset.expressionId || ""));
  });
}

function renderReviewActive() {
  const card = $("reviewActiveCard");
  if (!card) return;
  const item = activeExpressionItem();
  if (!item) {
    card.innerHTML = `<p class="hint">候補を選ぶと、ここにテキスト・カテゴリ・採用状態が出ます。</p>`;
    updateReviewButtons(null);
    return;
  }
  card.innerHTML = `
    <div class="review-active-meta">
      <span>${String(item.order + 1).padStart(3, "0")}</span>
      <strong>${escapeHtml(item.categoryLabel)}</strong>
      <em data-status="${item.status}">${escapeHtml(expressionStatusLabel(item.status))}</em>
    </div>
    <p>${escapeHtml(item.text)}</p>
    <small>${escapeHtml(item.caption)}</small>
    ${item.error ? `<strong class="review-error">${escapeHtml(item.error)}</strong>` : ""}
  `;
  updateReviewButtons(item);
}

function renderExpressionStats() {
  const counts = expressionCounts();
  const accepted = counts.accepted + counts.soundOnly;
  const html = `
    <div><span>候補</span><strong>${counts.total}</strong></div>
    <div><span>生成済み</span><strong>${counts.hasAudio}</strong></div>
    <div><span>採用</span><strong>${accepted}</strong></div>
    <div><span>保留</span><strong>${counts.hold}</strong></div>
    <div><span>録音</span><strong>${counts.recording}</strong></div>
    <div><span>ボツ</span><strong>${counts.rejected}</strong></div>
  `;
  const mini = $("expressionStatsMini");
  const material = $("materialStatsGrid");
  if (mini) mini.innerHTML = html;
  if (material) material.innerHTML = html;
  updateSpeakerMaterialProfileHint();
}

function updateReviewButtons(item) {
  [
    "acceptExpression",
    "soundOnlyExpression",
    "holdExpression",
    "recordingNeededExpression",
    "rejectExpression",
    "regenerateExpression",
    "nextReviewExpression",
  ].forEach((id) => {
    const button = $(id);
    if (!button) return;
    const needsAudio = ["acceptExpression", "soundOnlyExpression"].includes(id);
    const canRegenerate = id !== "regenerateExpression" || Boolean(item);
    const canMoveNext = id !== "nextReviewExpression" || Boolean(nextReviewCandidate() || nextReviewCandidate({ includeAnyAudio: true }));
    button.disabled = !item || (needsAudio && !item.hasAudio) || !canRegenerate || !canMoveNext;
  });
}

function activeExpressionItem() {
  return expressionQueue.find((item) => item.id === activeExpressionId) || null;
}

function selectExpressionItem(itemId) {
  const item = expressionQueue.find((candidate) => candidate.id === itemId);
  if (!item) return;
  activeExpressionId = item.id;
  const blob = expressionAudioBlobs.get(item.id);
  if (blob) {
    setBaseAudioBlob(blob, "expression");
    void drawAudioAnalysis(blob);
  }
  renderExpressionWorkflow();
}

function nextReviewCandidate({ includeAnyAudio = false } = {}) {
  const current = activeExpressionItem();
  const startOrder = current?.order ?? -1;
  const needsReview = (item) => item.hasAudio && (includeAnyAudio || item.status === "generated");
  return (
    expressionQueue.find((item) => item.order > startOrder && needsReview(item)) ||
    expressionQueue.find((item) => item.order <= startOrder && needsReview(item)) ||
    null
  );
}

function selectNextReviewCandidate() {
  const next = nextReviewCandidate() || nextReviewCandidate({ includeAnyAudio: true });
  if (!next) {
    renderExpressionWorkflow();
    log("次にチェックする生成済み候補はありません。表現音セットで次を生成してください。");
    return;
  }
  selectExpressionItem(next.id);
}

async function regenerateActiveExpressionCandidate() {
  const item = activeExpressionItem();
  if (!item) {
    log("再生成する候補を選んでください。");
    return;
  }
  $("regenerateExpression").disabled = true;
  try {
    await generateExpressionItem(item);
    setLabTab("review");
  } finally {
    $("regenerateExpression").disabled = false;
  }
}

function nextUngeneratedExpressionItem() {
  return expressionQueue.find((item) => !item.hasAudio && item.status !== "rejected" && item.status !== "recording") || null;
}

async function generateExpressionItem(item) {
  if (!item) {
    log("生成する候補がありません。");
    return null;
  }
  activeExpressionId = item.id;
  const settings = buildExpressionSettings(item);
  item.status = "generated";
  item.error = "";
  item.seed = settings.seed;
  renderExpressionWorkflow();
  resetCurrentPreviewForGeneration();
  clearPendingMaterialReference(settings);
  $("serverStatus").textContent = "生成中";
  $("expressionGenerationStatus").textContent = `${String(item.order + 1).padStart(3, "0")} / ${item.categoryLabel} を生成中... ${expressionSourceModeLabel(settings.expressionSourceMode)} / seed ${item.seed}`;
  try {
    if (shouldUploadReference(settings)) {
      const voiceId = voiceIdFromFilename(referenceFile.name);
      const uploaded = await uploadReferenceVoice(settings.endpoint, referenceFile, voiceId, settings.apiKey);
      $("voice").value = uploaded.voice_id || voiceId;
      settings.voice = $("voice").value;
      clearPendingReferenceFile();
      log(`参照音声を登録しました: ${settings.voice}`);
    }
    const result = await synthesizeSpeech(settings);
    const processed = await renderExpressionOutputAudio(result.blob, settings);
    expressionAudioBlobs.set(item.id, processed.blob);
    if (item.audioUrl) URL.revokeObjectURL(item.audioUrl);
    item.audioUrl = URL.createObjectURL(processed.blob);
    item.hasAudio = true;
    item.elapsedMs = result.elapsedMs;
    item.generatedAt = new Date().toISOString();
    setBaseAudioBlob(processed.blob, "expression");
    latestCard = buildCard(settings, processed.blob, {
      name: expressionItemFilename(item).replace(/\.wav$/, ""),
      elapsedMs: result.elapsedMs,
    });
    await drawAudioAnalysis(processed.blob);
    $("serverStatus").textContent = `${result.elapsedMs}ms`;
    $("expressionGenerationStatus").textContent = `${item.categoryLabel} / ${Math.round(processed.blob.size / 1024)}KB / ${result.elapsedMs}ms`;
    if (processed.notes.length) log(`表現音後処理: ${processed.notes.join(" / ")}`);
    log(`表現音生成: ${String(item.order + 1).padStart(3, "0")} ${item.categoryLabel} / ${expressionSourceModeLabel(settings.expressionSourceMode)} / seed ${item.seed} / ${result.elapsedMs}ms`);
    return item;
  } catch (error) {
    item.status = "hold";
    item.error = error instanceof Error ? error.message : String(error);
    $("serverStatus").textContent = "生成エラー";
    $("expressionGenerationStatus").textContent = `生成エラー: ${item.error}`;
    log(item.error);
    return null;
  } finally {
    renderExpressionWorkflow();
  }
}

async function generateNextExpressionCandidate() {
  if (!expressionQueue.length) buildExpressionQueue();
  const item = nextUngeneratedExpressionItem();
  if (!item) {
    log("未生成の候補はありません。");
    return;
  }
  $("generateNextExpression").disabled = true;
  $("generateAllExpressions").disabled = true;
  try {
    await generateExpressionItem(item);
    setLabTab("review");
  } finally {
    $("generateNextExpression").disabled = false;
    $("generateAllExpressions").disabled = false;
  }
}

async function generateAllExpressionCandidates() {
  if (!expressionQueue.length) buildExpressionQueue();
  expressionBatchRunning = true;
  $("generateNextExpression").disabled = true;
  $("generateAllExpressions").disabled = true;
  $("stopExpressionBatch").disabled = false;
  try {
    let generated = 0;
    while (expressionBatchRunning) {
      const item = nextUngeneratedExpressionItem();
      if (!item) break;
      await generateExpressionItem(item);
      generated += 1;
      await wait(120);
    }
    log(`連続生成を終了しました: ${generated}件。`);
    setLabTab("review");
  } finally {
    expressionBatchRunning = false;
    $("generateNextExpression").disabled = false;
    $("generateAllExpressions").disabled = false;
    $("stopExpressionBatch").disabled = true;
    $("expressionGenerationStatus").textContent = "連続生成を終了しました。人間チェックで採用してください。";
    renderExpressionWorkflow();
  }
}

function stopExpressionBatch() {
  expressionBatchRunning = false;
  $("expressionGenerationStatus").textContent = "停止要求を受け取りました。現在の1本が終わったら止まります。";
}

function setActiveExpressionStatus(status, { advance = false } = {}) {
  const item = activeExpressionItem();
  if (!item) {
    log("候補を選んでください。");
    return;
  }
  item.status = status;
  renderExpressionWorkflow();
  log(`${item.categoryLabel}: ${expressionStatusLabel(status)} / ${item.text}`);
  if (advance) selectNextReviewCandidate();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function textFile(text, type = "text/plain") {
  return new Blob([text], { type: `${type};charset=utf-8` });
}

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = crc32Table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    out.set(chunk, offset);
    offset += chunk.length;
  });
  return out;
}

async function createZipBlob(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const centralChunks = [];
  let offset = 0;
  const { date, time } = dosTimestamp();

  for (const entry of entries) {
    const name = String(entry.path).replace(/^\/+/, "");
    const nameBytes = encoder.encode(name);
    const dataBytes = new Uint8Array(await entry.blob.arrayBuffer());
    const checksum = crc32(dataBytes);
    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, dataBytes.length, true);
    localView.setUint32(22, dataBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, dataBytes);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, dataBytes.length, true);
    centralView.setUint32(24, dataBytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralChunks.push(central);

    offset += local.length + dataBytes.length;
  }

  const centralStart = offset;
  const centralDirectory = concatBytes(centralChunks);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralDirectory.length, true);
  endView.setUint32(16, centralStart, true);
  endView.setUint16(20, 0, true);
  return new Blob([...chunks, centralDirectory, end], { type: "application/zip" });
}

function buildTrainingJsonl(items = acceptedExpressionItems()) {
  return (
    items
      .map((item) =>
        JSON.stringify({
          audio: `wavs/${materialItemFilename(item)}`,
          text: item.text,
          caption: item.caption,
          speaker_id: "nanami-voice-labo",
          source_kind: item.sourceKind || "expression",
          voice_gender: item.voiceGender || currentExpressionGender(),
          voice_caption: item.voiceCaption || "",
          category: item.category,
          status: item.status,
        }),
      )
      .join("\n") + "\n"
  );
}

function buildSpeakerInversionNotes(items = acceptedExpressionItems()) {
  return `NANAMI VOICE LABO speaker material

Accepted clips: ${items.length}

This zip contains:
- wavs/: adopted wav clips
- dataset/metadata.jsonl: local dataset rows with relative wav paths
- nanami-expression-manifest.json: review metadata

checkpoint_final.speaker.safetensors is not a direct wav conversion.
The main route is the Lab button:

1. Open "調整から成果物".
2. Press "最終成果物を作成".
3. The bridge uploads adopted wavs, runs Irodori-TTS Speaker Inversion, and registers the completed checkpoint in "成果物テスト".

This zip is a backup / manual reproduction package. To reproduce the same flow manually:

1. Load dataset/metadata.jsonl as a local dataset, or convert it to the dataset format used by Irodori-TTS prepare_manifest.py.
2. Run prepare_manifest.py to precompute DACVAE latents.
3. Run train.py with:

uv run python train.py \\
  --config configs/train_500m_v3_speaker_inversion.yaml \\
  --manifest data/target_speaker_manifest.jsonl \\
  --init-checkpoint path/to/Irodori-TTS-500M-v3.safetensors \\
  --output-dir outputs/speaker_inversion/name

Expected final file:
outputs/speaker_inversion/name/checkpoint_final.speaker.safetensors
`;
}

function buildExpressionManifestData(items = acceptedExpressionItems(), materialProfile = null) {
  const accepted = items;
  const counts = expressionCounts();
  return {
    kind: "nanami-expression-dataset-manifest",
    createdAt: new Date().toISOString(),
    target: {
      futureSpeakerEmbedding: "checkpoint_final.speaker.safetensors",
      trainingMethod: "Speaker Inversion",
      baseModel: $("model")?.value || DEFAULT_MODEL,
    },
    materialProfile: materialProfile
      ? {
          id: materialProfile.id,
          label: materialProfile.label,
          description: materialProfile.description,
        }
      : null,
    counts,
    generalSpeech: {
      target: GENERAL_SPEECH_TARGET_COUNT,
      includedInFinalBuild: includeGeneralSpeechSetInFinal(),
      generated: generalSpeechMaterialItems().length,
    },
    voiceGender: currentExpressionGender(),
    categories: currentExpressionCategories().map(({ id, label, target }) => ({ id, label, target })),
    accepted: accepted.map((item) => ({
      id: item.id,
      order: item.order + 1,
      category: item.category,
      categoryLabel: item.categoryLabel,
      status: item.status,
      text: item.text,
      caption: item.caption,
      voiceGender: item.voiceGender || currentExpressionGender(),
      voiceCaption: item.voiceCaption || "",
      sourceKind: item.sourceKind || "expression",
      wav: `wavs/${materialItemFilename(item)}`,
      elapsedMs: item.elapsedMs,
      generatedAt: item.generatedAt,
      seed: item.seed,
    })),
    rejectedOrHeld: expressionQueue
      .filter((item) => !["accepted", "soundOnly"].includes(item.status))
      .map((item) => ({
        order: item.order + 1,
        category: item.category,
        status: item.status,
        text: item.text,
        error: item.error,
      })),
    note: "Use the included wav files and dataset/metadata.jsonl as source material. Irodori-TTS train.py consumes a latent manifest produced by prepare_manifest.py.",
  };
}

function generatedExpressionItems() {
  return expressionQueue.filter((item) => item.hasAudio && expressionAudioBlobs.has(item.id));
}

function linearToDb(value) {
  return 20 * Math.log10(Math.max(Number(value) || 0, 1e-12));
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(" / ") : String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function previousPowerOfTwo(value) {
  let n = 1;
  while (n * 2 <= value) n *= 2;
  return n;
}

function fftRadix2(real, imag) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wlenReal = Math.cos(angle);
    const wlenImag = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wReal = 1;
      let wImag = 0;
      for (let j = 0; j < len / 2; j += 1) {
        const uReal = real[i + j];
        const uImag = imag[i + j];
        const vReal = real[i + j + len / 2] * wReal - imag[i + j + len / 2] * wImag;
        const vImag = real[i + j + len / 2] * wImag + imag[i + j + len / 2] * wReal;
        real[i + j] = uReal + vReal;
        imag[i + j] = uImag + vImag;
        real[i + j + len / 2] = uReal - vReal;
        imag[i + j + len / 2] = uImag - vImag;
        const nextReal = wReal * wlenReal - wImag * wlenImag;
        wImag = wReal * wlenImag + wImag * wlenReal;
        wReal = nextReal;
      }
    }
  }
}

function spectralMetrics(samples, sampleRate) {
  const windowSize = Math.min(4096, previousPowerOfTwo(samples.length));
  if (!samples.length || !sampleRate || windowSize < 32) {
    return {
      centroidHz: 0,
      sub: 0,
      low: 0,
      mud: 0,
      body: 0,
      presence: 0,
      air: 0,
      hiss: 0,
      mudPresence: 0,
      clarity: 0,
      boom: 0,
      hiNoise: 0,
    };
  }

  const starts = [0.25, 0.5, 0.75]
    .map((ratio) => Math.max(0, Math.min(samples.length - windowSize, Math.floor(samples.length * ratio - windowSize / 2))))
    .filter((start, index, list) => list.indexOf(start) === index);
  const bands = { sub: 0, low: 0, mud: 0, body: 0, presence: 0, air: 0, hiss: 0 };
  let total = 0;
  let centroidNumerator = 0;

  starts.forEach((start) => {
    const real = new Float64Array(windowSize);
    const imag = new Float64Array(windowSize);
    let frameRms = 0;
    for (let i = 0; i < windowSize; i += 1) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, windowSize - 1));
      const value = samples[start + i] * window;
      real[i] = value;
      frameRms += value * value;
    }
    if (Math.sqrt(frameRms / windowSize) < 10 ** (-50 / 20)) return;
    fftRadix2(real, imag);
    for (let k = 1; k < windowSize / 2; k += 1) {
      const freq = (k * sampleRate) / windowSize;
      const power = real[k] * real[k] + imag[k] * imag[k];
      total += power;
      centroidNumerator += freq * power;
      if (freq < 20) continue;
      if (freq < 100) bands.sub += power;
      else if (freq < 250) bands.low += power;
      else if (freq < 800) bands.mud += power;
      else if (freq < 1800) bands.body += power;
      else if (freq < 5000) bands.presence += power;
      else if (freq < 9000) bands.air += power;
      else if (freq < Math.min(14000, sampleRate / 2)) bands.hiss += power;
    }
  });

  const divisor = Math.max(total, 1e-12);
  const normalized = Object.fromEntries(Object.entries(bands).map(([key, value]) => [key, value / divisor]));
  return {
    centroidHz: centroidNumerator / divisor,
    ...normalized,
    mudPresence: normalized.mud / Math.max(normalized.presence, 1e-12),
    clarity: (normalized.presence + normalized.air) / Math.max(normalized.mud + normalized.body, 1e-12),
    boom: normalized.sub + normalized.low,
    hiNoise: normalized.air + normalized.hiss,
  };
}

function waveformPeaks(samples, buckets = 180) {
  const peaks = [];
  const step = Math.max(1, Math.floor(samples.length / buckets));
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = bucket * step;
    let min = 0;
    let max = 0;
    for (let i = 0; i < step && start + i < samples.length; i += 1) {
      const value = samples[start + i];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    peaks.push([Number(min.toFixed(4)), Number(max.toFixed(4))]);
  }
  return peaks;
}

async function analyzeExpressionAudioBlob(item, blob) {
  const buffer = await decodeBlob(blob);
  const samples = monoSamples(buffer);
  const duration = samples.length / buffer.sampleRate;
  let peak = 0;
  let sumSquares = 0;
  let clipped = 0;
  let silence = 0;
  let zeroCrossings = 0;
  let dc = 0;
  const silenceThreshold = 10 ** (-45 / 20);
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    const abs = Math.abs(value);
    peak = Math.max(peak, abs);
    sumSquares += value * value;
    dc += value;
    if (abs >= 0.98) clipped += 1;
    if (abs < silenceThreshold) silence += 1;
    if (i > 0 && ((samples[i - 1] < 0 && value >= 0) || (samples[i - 1] >= 0 && value < 0))) zeroCrossings += 1;
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, samples.length));
  const frameSize = Math.max(1, Math.floor(buffer.sampleRate * 0.02));
  const frameCount = Math.floor(samples.length / frameSize);
  let firstVoiced = -1;
  let lastVoiced = -1;
  for (let frame = 0; frame < frameCount; frame += 1) {
    let frameSquares = 0;
    const start = frame * frameSize;
    for (let i = 0; i < frameSize; i += 1) frameSquares += samples[start + i] * samples[start + i];
    if (Math.sqrt(frameSquares / frameSize) >= silenceThreshold) {
      if (firstVoiced < 0) firstVoiced = frame;
      lastVoiced = frame;
    }
  }
  const leadingSilence = firstVoiced >= 0 ? (firstVoiced * frameSize) / buffer.sampleRate : duration;
  const trailingSilence = lastVoiced >= 0 ? ((frameCount - 1 - lastVoiced) * frameSize) / buffer.sampleRate : duration;
  const spectral = spectralMetrics(samples, buffer.sampleRate);
  return {
    id: item.id,
    order: item.order + 1,
    category: item.category,
    categoryLabel: item.categoryLabel,
    status: item.status,
    text: item.text,
    caption: item.caption,
    voiceGender: item.voiceGender || currentExpressionGender(),
    voiceCaption: item.voiceCaption || "",
    wav: `wavs/${expressionItemFilename(item)}`,
    bytes: blob.size,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    duration: Number(duration.toFixed(3)),
    rmsDb: Number(linearToDb(rms).toFixed(2)),
    peakDb: Number(linearToDb(peak).toFixed(2)),
    clipPct: Number(((clipped / Math.max(1, samples.length)) * 100).toFixed(4)),
    silencePct: Number(((silence / Math.max(1, samples.length)) * 100).toFixed(2)),
    leadingSilence: Number(leadingSilence.toFixed(3)),
    trailingSilence: Number(trailingSilence.toFixed(3)),
    zeroCrossingsPerSec: Number((zeroCrossings / Math.max(duration, 1e-6)).toFixed(1)),
    dcOffset: Number((dc / Math.max(1, samples.length)).toFixed(6)),
    centroidHz: Number(spectral.centroidHz.toFixed(1)),
    mudPresence: Number(spectral.mudPresence.toFixed(3)),
    clarity: Number(spectral.clarity.toFixed(3)),
    boom: Number(spectral.boom.toFixed(3)),
    hiNoise: Number(spectral.hiNoise.toFixed(3)),
    bands: {
      sub: Number(spectral.sub.toFixed(4)),
      low: Number(spectral.low.toFixed(4)),
      mud: Number(spectral.mud.toFixed(4)),
      body: Number(spectral.body.toFixed(4)),
      presence: Number(spectral.presence.toFixed(4)),
      air: Number(spectral.air.toFixed(4)),
      hiss: Number(spectral.hiss.toFixed(4)),
    },
    waveformPeaks: waveformPeaks(samples),
    seed: item.seed,
    elapsedMs: item.elapsedMs,
    generatedAt: item.generatedAt,
  };
}

function quantile(values, ratio) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * ratio;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  const weight = index - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

function finalizeExpressionAnalyses(rows) {
  const enoughForRelativeFlags = rows.length >= 6;
  const mudQ75 = quantile(rows.map((row) => row.mudPresence), 0.75);
  const mudQ9 = quantile(rows.map((row) => row.mudPresence), 0.9);
  const clarityQ25 = quantile(rows.map((row) => row.clarity), 0.25);
  const clarityQ75 = quantile(rows.map((row) => row.clarity), 0.75);
  const hiNoiseQ8 = quantile(rows.map((row) => row.hiNoise), 0.8);
  const zcrQ8 = quantile(rows.map((row) => row.zeroCrossingsPerSec), 0.8);
  rows.forEach((row) => {
    const flags = [];
    let score = 100;
    if (row.clipPct > 0.01 || row.peakDb > -0.2) {
      flags.push("クリップ注意");
      score -= 18;
    }
    if (row.leadingSilence > 0.45) {
      flags.push("頭無音長め");
      score -= Math.min(12, row.leadingSilence * 10);
    }
    if (row.trailingSilence > 0.75) {
      flags.push("末尾無音長め");
      score -= Math.min(12, row.trailingSilence * 8);
    }
    if (row.duration < 2) {
      flags.push("短すぎ");
      score -= 15;
    }
    if (row.rmsDb < -27) {
      flags.push("音量小さめ");
      score -= 8;
    }
    if (row.rmsDb > -12) {
      flags.push("音量大きめ");
      score -= 8;
    }
    if (enoughForRelativeFlags && row.mudPresence >= mudQ9) {
      flags.push("かなりこもり寄り");
      score -= 16;
    } else if (enoughForRelativeFlags && row.mudPresence >= mudQ75) {
      flags.push("こもり寄り");
      score -= 9;
    }
    if (enoughForRelativeFlags && row.clarity <= clarityQ25) {
      flags.push("抜け弱め");
      score -= 7;
    }
    if (enoughForRelativeFlags && row.hiNoise >= hiNoiseQ8 && row.zeroCrossingsPerSec >= zcrQ8) {
      flags.push("高域硬め/機械音候補");
      score -= 9;
    }
    if (row.boom > 0.12) {
      flags.push("低域多め");
      score -= 5;
    }
    if (enoughForRelativeFlags && row.clarity >= clarityQ75 && row.mudPresence < mudQ75 && row.clipPct <= 0.01) {
      flags.push("抜け良い");
      score += 6;
    }
    row.flags = flags.length ? flags : ["大きな波形問題なし"];
    row.score = Number(Math.max(0, Math.min(110, score)).toFixed(1));
  });
  return {
    mudPresenceQ75: Number(mudQ75.toFixed(3)),
    mudPresenceQ90: Number(mudQ9.toFixed(3)),
    clarityQ25: Number(clarityQ25.toFixed(3)),
    clarityQ75: Number(clarityQ75.toFixed(3)),
    hiNoiseQ80: Number(hiNoiseQ8.toFixed(3)),
    zcrQ80: Number(zcrQ8.toFixed(1)),
  };
}

function buildAnalysisCsv(rows) {
  const headers = [
    "order",
    "categoryLabel",
    "status",
    "duration",
    "rmsDb",
    "peakDb",
    "clipPct",
    "leadingSilence",
    "trailingSilence",
    "mudPresence",
    "clarity",
    "hiNoise",
    "zeroCrossingsPerSec",
    "score",
    "flags",
    "wav",
    "text",
  ];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\n") + "\n";
}

function buildWaveformReviewHtml(rows) {
  const payload = JSON.stringify(rows.map((row) => ({
    order: row.order,
    categoryLabel: row.categoryLabel,
    status: row.status,
    text: row.text,
    wav: `../${row.wav}`,
    duration: row.duration,
    rmsDb: row.rmsDb,
    peakDb: row.peakDb,
    mudPresence: row.mudPresence,
    clarity: row.clarity,
    score: row.score,
    flags: row.flags,
    waveformPeaks: row.waveformPeaks,
  }))).replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NANAMI VOICE LABO waveform review</title>
  <style>
    :root { color-scheme: dark; --bg:#041012; --panel:#071b20; --line:#19545d; --cyan:#7dfaff; --ink:#e9feff; --muted:#92c9d1; --rose:#ff7ae8; }
    * { box-sizing:border-box; }
    body { margin:0; background:linear-gradient(135deg,#030809,#08222a); color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic",sans-serif; }
    main { max-width:1280px; margin:0 auto; padding:24px; }
    h1 { margin:0 0 8px; font-size:28px; }
    p { color:var(--muted); }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:14px; }
    article { border:1px solid var(--line); border-radius:10px; background:rgba(7,27,32,.86); padding:12px; box-shadow:0 0 24px rgba(125,250,255,.08); }
    header { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:8px; }
    strong { color:var(--cyan); }
    small { color:var(--muted); }
    svg { width:100%; height:92px; display:block; background:#02080b; border:1px solid rgba(125,250,255,.16); border-radius:8px; }
    audio { width:100%; margin-top:8px; }
    .flags { min-height:1.6em; color:var(--rose); font-weight:800; }
    .metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:6px; margin:8px 0; }
    .metrics span { border:1px solid rgba(125,250,255,.16); border-radius:7px; padding:5px 6px; color:var(--muted); font-size:12px; }
    .metrics b { display:block; color:var(--ink); font-size:13px; }
  </style>
</head>
<body>
  <main>
    <h1>NANAMI VOICE LABO waveform review</h1>
    <p>生成済み候補 ${rows.length}件。波形と音量・こもり目安を見ながら耳チェックできます。</p>
    <div id="grid" class="grid"></div>
  </main>
  <script>
    const rows = ${payload};
    const grid = document.getElementById("grid");
    function esc(value) {
      return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[char]));
    }
    function waveformSvg(peaks) {
      const width = 360;
      const height = 92;
      const mid = height / 2;
      const step = width / Math.max(1, peaks.length - 1);
      const lines = peaks.map(([min, max], index) => {
        const x = (index * step).toFixed(1);
        const y1 = (mid - max * (height * 0.43)).toFixed(1);
        const y2 = (mid - min * (height * 0.43)).toFixed(1);
        return '<line x1="' + x + '" x2="' + x + '" y1="' + y1 + '" y2="' + y2 + '" />';
      }).join("");
      return '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img"><g stroke="rgba(125,250,255,.18)" stroke-width="1"><line x1="0" y1="' + mid + '" x2="' + width + '" y2="' + mid + '" /></g><g stroke="#7dfaff" stroke-width="1.4">' + lines + '</g></svg>';
    }
    grid.innerHTML = rows.map((row) => '<article><header><div><strong>' + String(row.order).padStart(3, "0") + ' ' + esc(row.categoryLabel) + '</strong><br><small>' + esc(row.text) + '</small></div><strong>' + row.score + '</strong></header>' + waveformSvg(row.waveformPeaks) + '<div class="metrics"><span>秒<b>' + row.duration + '</b></span><span>RMS<b>' + row.rmsDb + '</b></span><span>こもり<b>' + row.mudPresence + '</b></span><span>抜け<b>' + row.clarity + '</b></span></div><div class="flags">' + esc(row.flags.join(" / ")) + '</div><audio controls src="' + esc(row.wav) + '"></audio></article>').join("");
  </script>
</body>
</html>
`;
}

function buildGeneratedAnalysisManifest(rows, thresholds) {
  const durations = rows.map((row) => row.duration);
  const rms = rows.map((row) => row.rmsDb);
  return {
    kind: "nanami-expression-analysis",
    createdAt: new Date().toISOString(),
    generatedCount: rows.length,
    averageDuration: Number((durations.reduce((sum, value) => sum + value, 0) / Math.max(1, rows.length)).toFixed(3)),
    averageRmsDb: Number((rms.reduce((sum, value) => sum + value, 0) / Math.max(1, rows.length)).toFixed(2)),
    thresholds,
    recommended: rows.slice().sort((a, b) => b.score - a.score).slice(0, 12).map((row) => row.order),
    needsReview: rows.slice().sort((a, b) => a.score - b.score).slice(0, 12).map((row) => row.order),
    rows,
  };
}

async function downloadGeneratedExpressionAnalysisZip() {
  const items = generatedExpressionItems();
  if (!items.length) {
    log("解析できる生成済みwavがありません。表現音セットで候補を生成してください。");
    return;
  }
  $("downloadReviewAnalysis").disabled = true;
  log(`解析zipを作成中: ${items.length}件。`);
  try {
    const rows = [];
    for (const item of items) {
      const blob = expressionAudioBlobs.get(item.id);
      if (!blob) continue;
      rows.push(await analyzeExpressionAudioBlob(item, blob));
    }
    const thresholds = finalizeExpressionAnalyses(rows);
    const manifest = buildGeneratedAnalysisManifest(rows, thresholds);
    const entries = [
      {
        path: "analysis/summary.json",
        blob: textFile(JSON.stringify(manifest, null, 2), "application/json"),
      },
      {
        path: "analysis/summary.csv",
        blob: textFile(buildAnalysisCsv(rows), "text/csv"),
      },
      {
        path: "analysis/waveform-review.html",
        blob: textFile(buildWaveformReviewHtml(rows), "text/html"),
      },
      {
        path: "README-analysis.txt",
        blob: textFile(
          `NANAMI VOICE LABO generated-candidate analysis

This package contains every generated review candidate without changing accept/reject status.

- wavs/: generated wav files
- analysis/summary.json: metrics, flags, recommended and needsReview order lists
- analysis/summary.csv: spreadsheet-friendly metrics
- analysis/waveform-review.html: extract this zip, then open this file to review waveforms with audio controls

The score is a rough machine triage only. Final selection should still be done by ear.
`,
        ),
      },
    ];
    for (const row of rows) {
      const item = expressionQueue.find((candidate) => candidate.id === row.id);
      const blob = item ? expressionAudioBlobs.get(item.id) : null;
      if (blob) entries.push({ path: row.wav, blob });
    }
    const zip = await createZipBlob(entries);
    downloadBlob(zip, `nanami-review-analysis-${new Date().toISOString().slice(0, 10)}.zip`);
    log(`解析zipを書き出しました: wav ${rows.length}件 / ${Math.round(zip.size / 1024)}KB`);
  } finally {
    $("downloadReviewAnalysis").disabled = false;
  }
}

async function downloadAcceptedExpressionWavs() {
  const items = acceptedExpressionItems();
  if (!items.length) {
    log("採用済みwavがありません。");
    return;
  }
  const entries = [
    {
      path: "nanami-expression-manifest.json",
      blob: textFile(JSON.stringify(buildExpressionManifestData(), null, 2), "application/json"),
    },
    {
      path: "dataset/metadata.jsonl",
      blob: textFile(buildTrainingJsonl(items), "application/x-ndjson"),
    },
    {
      path: "README-speaker-inversion.txt",
      blob: textFile(buildSpeakerInversionNotes(items)),
    },
  ];
  for (const item of items) {
    const blob = expressionAudioBlobs.get(item.id);
    if (!blob) continue;
    entries.push({ path: `wavs/${expressionItemFilename(item)}`, blob });
  }
  const zip = await createZipBlob(entries);
  downloadBlob(zip, `nanami-expression-set-${new Date().toISOString().slice(0, 10)}.zip`);
  log(`採用セットzipを書き出しました: wav ${items.length}件 / ${Math.round(zip.size / 1024)}KB`);
}

function exportTrainingJsonl() {
  const items = acceptedExpressionItems();
  if (!items.length) {
    log("JSONLに入れる採用候補がありません。");
    return;
  }
  downloadBlob(
    textFile(buildTrainingJsonl(items), "application/x-ndjson"),
    `nanami-expression-metadata-${new Date().toISOString().slice(0, 10)}.jsonl`,
  );
  log(`metadata.jsonlを書き出しました: ${items.length}件。`);
}

function exportExpressionManifest() {
  const accepted = acceptedExpressionItems();
  if (!accepted.length) {
    log("manifestに入れる採用候補がありません。");
    return false;
  }
  const manifest = buildExpressionManifestData();
  downloadBlob(
    new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }),
    `nanami-expression-manifest-${new Date().toISOString().slice(0, 10)}.json`,
  );
  log(`表現音manifestを書き出しました: 採用 ${accepted.length}件。`);
  return true;
}

function cardNameFromSettings(settings) {
  const text = settings.text || settings.caption || "Voice";
  return text.replace(/\s+/g, " ").trim().slice(0, 28) || "Voice Card";
}

function buildCard(settings, audioBlob = null, extra = {}) {
  return {
    id: extra.id || crypto.randomUUID(),
    name: extra.name || cardNameFromSettings(settings),
    engine: "openai-compatible-nanami-labo",
    endpoint: settings.endpoint,
    model: settings.model,
    voice: settings.voice,
    finalArtifactId: settings.finalArtifactId || "",
    format: settings.format,
    text: settings.text,
    caption: settings.caption,
    speed: settings.speed,
    pitch: settings.pitch,
    seed: settings.seed,
    numSteps: settings.numSteps,
    cfgMode: settings.cfgMode || "independent",
    cfgText: settings.cfgText,
    cfgCaption: settings.cfgCaption,
    cfgSpeaker: settings.cfgSpeaker,
    scheduleMode: settings.scheduleMode,
    swayCoeff: settings.swayCoeff,
    durationScale: settings.durationScale,
    sculpt: settings.sculpt || readSculptSettings(),
    elapsedMs: extra.elapsedMs || null,
    rating: extra.rating ?? 0,
    hasAudio: Boolean(audioBlob),
  };
}

function renderRating(card) {
  const rating = Math.min(5, Math.max(0, Number(card.rating) || 0));
  return `
    <div class="card-rating" aria-label="評価 ${rating} / 5">
      ${[1, 2, 3, 4, 5]
        .map(
          (value) =>
            `<button type="button" data-rating="${value}" aria-label="${value}つ星">${
              value <= rating ? "★" : "☆"
            }</button>`,
        )
        .join("")}
    </div>
  `;
}

function modelLabel(model) {
  const modeSuffix =
    model.mode === "reference"
      ? "reference"
      : model.mode === "speaker-inversion"
        ? "speaker inversion"
      : model.mode === "voice-design"
        ? "voice design"
        : model.mode === "auto"
          ? "auto"
          : "";
  return modeSuffix ? `${model.label} (${modeSuffix})` : model.label;
}

function renderModelOptions(models = FALLBACK_MODELS) {
  const select = $("model");
  const currentValue = normalizeModelChoice(select.value);
  const bridgeModels = new Map(
    models
      .filter((model) => selectableModelIds.has(model.id))
      .map((model) => [model.id, model]),
  );

  select.innerHTML = "";
  FALLBACK_MODELS.forEach((fallback) => {
    const model = bridgeModels.get(fallback.id) || fallback;
    const option = document.createElement("option");
    option.value = fallback.id;
    option.textContent = modelLabel(model);
    select.appendChild(option);
  });
  select.value = currentValue;
  if (!select.value) select.value = DEFAULT_MODEL;
  updatePayloadPreview();
}

function scheduleBridgeRefresh() {
  globalThis.clearTimeout(bridgeRefreshTimer);
  bridgeRefreshTimer = globalThis.setTimeout(() => void refreshBridgeInfo({ quiet: true }), 700);
}

async function refreshBridgeInfo({ quiet = false } = {}) {
  const endpoint = $("endpoint").value;
  $("bridgeState").textContent = "確認中...";
  $("serverStatus").textContent = "確認中";
  try {
    const info = await fetchBridgeInfo(endpoint);
    if (info.models.length) renderModelOptions(info.models);
    const usableCount = info.models.filter((model) => selectableModelIds.has(model.id)).length;
    const scriptwriter = info.rawHealth?.scriptwriter;
    const scriptwriterText = scriptwriter?.online
      ? `Gemma ready: ${info.rawHealth?.scriptwriterModel || "scriptwriter"}`
      : "Gemma未起動: LOCAL LINE fallback";
    $("serverStatus").textContent = info.ready ? "接続OK" : info.reachable ? "要確認" : "未接続";
    $("bridgeState").textContent = info.ready ? "bridge ready" : info.reachable ? "bridge reachable" : "接続できません";
    $("modelsStatus").textContent =
      usableCount > 0
        ? `bridge から ${usableCount} 件のモデル候補を取得しました。${scriptwriterText}`
        : info.reachable
          ? `bridge に接続しましたが、既定のローカル候補を使用します。${scriptwriterText}`
          : "手動URLを確認してください。未接続でも設定カードは保存できます。";
    if (!quiet) log(`bridge確認: ${info.message}`);
  } catch (error) {
    $("serverStatus").textContent = "未接続";
    $("bridgeState").textContent = "接続できません";
    $("modelsStatus").textContent = "手動URLを確認してください。未接続でも設定カードは保存できます。";
    if (!quiet) log(error instanceof Error ? error.message : String(error));
  }
}

function finalArtifactNotes() {
  try {
    return JSON.parse(localStorage.getItem(FINAL_ARTIFACT_NOTES_KEY) || "{}");
  } catch {
    return {};
  }
}

function hiddenFinalArtifactIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FINAL_ARTIFACT_HIDDEN_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function saveHiddenFinalArtifactIds(hidden) {
  localStorage.setItem(FINAL_ARTIFACT_HIDDEN_KEY, JSON.stringify([...hidden]));
}

function finalArtifactDescription(artifact) {
  const notes = finalArtifactNotes();
  const saved = String(notes[artifact.artifact_id] || "").trim();
  if (saved) return saved;
  const description = String(artifact.description || "").trim();
  if (description) return description;
  return DEFAULT_FINAL_ARTIFACT_DESCRIPTION;
}

function finalArtifactDescriptionDraft(artifact) {
  if (!artifact) return "";
  if (editingFinalArtifactId === artifact.artifact_id) {
    const value = $("finalArtifactDescription")?.value;
    if (typeof value === "string") return value.trim() || "説明メモなし";
  }
  return finalArtifactDescription(artifact);
}

function finalArtifactModelLabel(modelId) {
  const labels = {
    "irodori-nanami-final-500m": "ななみ最終 500M",
    "irodori-v3-lab-engine": "ラボ常駐エンジン",
    "irodori-speaker-inversion-500m-v3": "500M Speaker Inversion",
  };
  return labels[modelId] || modelId || "モデル未指定";
}

function saveFinalArtifactDescription() {
  const artifact = finalArtifacts.find((item) => item.artifact_id === editingFinalArtifactId);
  if (!artifact) {
    log("左の完成カードの編集ボタンから、説明を保存する成果物を選んでください。");
    return;
  }
  const notes = finalArtifactNotes();
  notes[artifact.artifact_id] = $("finalArtifactDescription").value.trim();
  localStorage.setItem(FINAL_ARTIFACT_NOTES_KEY, JSON.stringify(notes));
  editingFinalArtifactId = "";
  renderFinalArtifacts();
  renderFinalArtifactEditPanel();
  log(`成果物メモを保存しました: ${artifact.display_name || artifact.artifact_id}`);
}

function beginFinalArtifactCardEdit(artifactId) {
  const artifact = finalArtifacts.find((item) => item.artifact_id === artifactId);
  if (!artifact) return;
  activeFinalArtifactId = artifact.artifact_id;
  editingFinalArtifactId = artifact.artifact_id;
  renderFinalArtifacts();
  renderFinalArtifactEditPanel();
  $("finalArtifactDescription")?.focus();
}

function cancelFinalArtifactCardEdit() {
  editingFinalArtifactId = "";
  renderFinalArtifacts();
  renderFinalArtifactEditPanel();
}

function forgetFinalArtifactLocalState(artifactId) {
  const notes = finalArtifactNotes();
  delete notes[artifactId];
  localStorage.setItem(FINAL_ARTIFACT_NOTES_KEY, JSON.stringify(notes));
  const hidden = hiddenFinalArtifactIds();
  hidden.delete(artifactId);
  saveHiddenFinalArtifactIds(hidden);
}

function hideActiveFinalArtifactCard() {
  const artifact = activeFinalArtifact();
  if (!artifact) {
    log("非表示にする完成カードを選んでください。");
    return;
  }
  const hidden = hiddenFinalArtifactIds();
  hidden.add(artifact.artifact_id);
  saveHiddenFinalArtifactIds(hidden);
  finalArtifacts = finalArtifacts.filter((item) => item.artifact_id !== artifact.artifact_id);
  activeFinalArtifactId = finalArtifacts[0]?.artifact_id || "";
  if (editingFinalArtifactId === artifact.artifact_id) editingFinalArtifactId = "";
  renderFinalArtifacts();
  renderFinalArtifactEditPanel();
  log(`完成カードを一覧から外しました: ${artifact.display_name || artifact.artifact_id}`);
}

async function deleteActiveFinalArtifactFiles() {
  const artifact = activeFinalArtifact();
  if (!artifact) {
    log("削除する完成カードを選んでください。");
    return;
  }
  if (artifact.builtin) {
    log("同梱固定サンプルは、ラボ画面から実ファイル削除できません。");
    return;
  }
  const name = artifact.display_name || artifact.artifact_id;
  const targetLabel = artifact.runtime ? ".runtime/final_artifacts" : "assets/final";
  const ok = globalThis.confirm?.(
    `生成物も削除しますか？\n\n${name}\n\n${targetLabel} 内の safetensors と manifest を削除します。`,
  );
  if (!ok) return;
  $("deleteFinalArtifactFiles").disabled = true;
  try {
    await deleteFinalArtifact($("endpoint").value, artifact.artifact_id, $("apiKey").value);
    forgetFinalArtifactLocalState(artifact.artifact_id);
    activeFinalArtifactId = "";
    if (editingFinalArtifactId === artifact.artifact_id) editingFinalArtifactId = "";
    await loadFinalArtifacts();
    log(`成果物ファイルを削除しました: ${name}`);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
  } finally {
    $("deleteFinalArtifactFiles").disabled = false;
  }
}

function ensureBaseFinalArtifact(artifacts = []) {
  return artifacts;
}

function activeFinalArtifact() {
  return finalArtifacts.find((artifact) => artifact.artifact_id === activeFinalArtifactId) || finalArtifacts[0] || null;
}

async function loadFinalArtifacts() {
  try {
    const artifacts = await fetchFinalArtifacts($("endpoint").value, $("apiKey").value);
    const hidden = hiddenFinalArtifactIds();
    finalArtifacts = ensureBaseFinalArtifact(artifacts.filter((artifact) => !hidden.has(artifact.artifact_id)));
    if (!finalArtifacts.some((artifact) => artifact.artifact_id === activeFinalArtifactId)) {
      activeFinalArtifactId = finalArtifacts[0]?.artifact_id || "";
    }
    renderFinalArtifacts();
    renderFinalArtifactEditPanel();
  } catch (error) {
    finalArtifacts = [];
    activeFinalArtifactId = "";
    renderFinalArtifacts();
    renderFinalArtifactEditPanel();
    log(error instanceof Error ? error.message : String(error));
  }
}

function renderFinalArtifacts() {
  const grid = $("finalArtifactGrid");
  if (!grid) return;
  if (!finalArtifacts.length) {
    grid.innerHTML = `<p class="hint">完成済み成果物はまだありません。</p>`;
    return;
  }
  grid.innerHTML = finalArtifacts
    .map((artifact) => {
      const selected = artifact.artifact_id === activeFinalArtifactId;
      const editing = artifact.artifact_id === editingFinalArtifactId;
      const size = artifact.bytes ? `${Math.max(1, Math.round(artifact.bytes / 1024))}KB` : "サンプル";
      const baseReady = artifact.base_checkpoint_exists === false ? "500M未確認" : "500M準備OK";
      return `
        <article class="final-artifact-card ${selected ? "is-active" : ""} ${editing ? "is-editing" : ""}">
          <button class="final-artifact-select-button" type="button" data-final-artifact-id="${escapeHtml(artifact.artifact_id)}">
            <span>${artifact.builtin ? "同梱" : "完成"}</span>
            <strong>${escapeHtml(artifact.display_name || artifact.artifact_id)}</strong>
            <small>${escapeHtml(finalArtifactDescriptionDraft(artifact)).slice(0, 120)}</small>
            <em>話者埋め込み / ${size} / ${baseReady}</em>
          </button>
          <button class="final-artifact-edit-button" type="button" data-final-artifact-edit-id="${escapeHtml(artifact.artifact_id)}">編集</button>
        </article>
      `;
    })
    .join("");
  grid.querySelectorAll("[data-final-artifact-id]").forEach((button) => {
    button.addEventListener("click", () => {
      activeFinalArtifactId = button.dataset.finalArtifactId || "";
      renderFinalArtifacts();
      renderFinalArtifactEditPanel();
    });
  });
  grid.querySelectorAll("[data-final-artifact-edit-id]").forEach((button) => {
    button.addEventListener("click", () => beginFinalArtifactCardEdit(button.dataset.finalArtifactEditId || ""));
  });
}

function renderFinalArtifactEditPanel() {
  const description = $("finalArtifactDescription");
  const title = $("finalArtifactEditTitle");
  if (!description) return;
  const artifact = activeFinalArtifact();
  const editingArtifact = finalArtifacts.find((item) => item.artifact_id === editingFinalArtifactId) || null;
  const hideButton = $("hideFinalArtifactCard");
  const deleteButton = $("deleteFinalArtifactFiles");
  const downloadButton = $("downloadFinalArtifact");
  const generateButton = $("generateFinalArtifactTest");
  const saveButton = $("saveFinalArtifactDescription");
  const cancelButton = $("cancelFinalArtifactDescription");
  if (!artifact) {
    if (title) title.textContent = "カードを選択";
    description.value = "";
    description.disabled = true;
    if (hideButton) hideButton.disabled = true;
    if (deleteButton) deleteButton.disabled = true;
    if (downloadButton) downloadButton.disabled = true;
    if (generateButton) generateButton.disabled = true;
    if (saveButton) saveButton.disabled = true;
    if (cancelButton) cancelButton.disabled = true;
    return;
  }
  if (hideButton) hideButton.disabled = false;
  if (deleteButton) deleteButton.disabled = Boolean(artifact.builtin);
  if (downloadButton) downloadButton.disabled = false;
  if (generateButton) generateButton.disabled = false;
  if (saveButton) saveButton.disabled = !editingArtifact;
  if (cancelButton) cancelButton.disabled = !editingArtifact;
  if (title) {
    title.textContent = editingArtifact
      ? `${editingArtifact.display_name || editingArtifact.artifact_id} を編集中`
      : "左カードの編集ボタンでメモを書き換え";
  }
  description.disabled = !editingArtifact;
  description.value = editingArtifact
    ? finalArtifactDescription(editingArtifact)
    : finalArtifactDescription(artifact);
}

async function generateFinalArtifactTest() {
  const artifact = activeFinalArtifact();
  if (!artifact) {
    log("テストする完成カードを選んでください。");
    return;
  }
  if (!artifact.bytes || artifact.bytes <= 0) {
    log("有効なsafetensorsを持つ完成カードだけテストできます。");
    return;
  }
  const text = $("finalArtifactText").value.trim();
  if (!text) {
    log("テスト本文を入力してください。");
    return;
  }
  const settings = {
    ...readSettings(),
    ...FINAL_ARTIFACT_TEST_SETTINGS,
    model: FINAL_ARTIFACT_TEST_MODEL,
    voice: "none",
    text,
    caption: "",
    voiceCaption: "",
    finalArtifactId: artifact.artifact_id,
  };
  resetCurrentPreviewForGeneration();
  $("generateFinalArtifactTest").disabled = true;
  $("serverStatus").textContent = "生成中";
  try {
    const payload = buildSpeechPayload(settings);
    log(`成果物テスト生成: ${payload.model} / final=${settings.finalArtifactId}`);
    const result = await synthesizeSpeech(settings);
    setBaseAudioBlob(result.blob, "final-artifact");
    latestCard = buildCard(settings, result.blob, {
      name: `${safeFilename(artifact.display_name || artifact.artifact_id)}-test`,
      elapsedMs: result.elapsedMs,
    });
    await drawAudioAnalysis(result.blob);
    $("serverStatus").textContent = `${result.elapsedMs}ms`;
    log(`成果物テスト完了: ${Math.round(result.blob.size / 1024)}KB / ${result.elapsedMs}ms`);
  } catch (error) {
    $("serverStatus").textContent = "生成エラー";
    log(error instanceof Error ? error.message : String(error));
  } finally {
    $("generateFinalArtifactTest").disabled = false;
  }
}

function shouldUploadReference(settings) {
  return referenceFile && settings.voice === "none";
}

async function renderCards() {
  const cards = await listVoiceCards();
  const grid = $("cardsGrid");
  if (cards.length === 0) {
    grid.innerHTML = `<article class="voice-card"><h3>まだカードはありません</h3><p>生成した声や気に入った設定を保存すると、ここから再生・再生成・書き出しできます。</p></article>`;
    return;
  }

  grid.innerHTML = "";
  for (const card of cards) {
    const audioBlob = card.hasAudio ? await getAudioBlob(card.id) : null;
    const audioUrl = audioBlob ? URL.createObjectURL(audioBlob) : "";
    const article = document.createElement("article");
    article.className = "voice-card";
    article.innerHTML = `
      <header>
        <div>
          <h3>${escapeHtml(card.name)}</h3>
          <p>${escapeHtml(card.text).slice(0, 86)}${card.text.length > 86 ? "..." : ""}</p>
        </div>
      </header>
      <div class="card-meta">
        <span>${escapeHtml(card.model)}</span>
        <span>${escapeHtml(card.voice)}</span>
        <span>${escapeHtml(card.format)}</span>
        <span>speed ${card.speed}</span>
        <span>seed ${card.seed}</span>
      </div>
      ${renderRating(card)}
      ${audioUrl ? `<audio controls src="${audioUrl}"></audio>` : `<p>音声ファイルなし。設定カードとして保存されています。</p>`}
      <div class="card-actions">
        <button type="button" data-action="load">読込</button>
        ${audioUrl ? `<a href="${audioUrl}" download="${safeFilename(card.name)}.${card.format}">保存</a>` : `<button type="button" disabled>保存</button>`}
        ${audioUrl ? `<button type="button" data-action="use-source">成果物へ送る</button>` : `<button type="button" disabled>成果物へ送る</button>`}
        <button type="button" data-action="delete">削除</button>
      </div>
    `;
    article.querySelector('[data-action="load"]').addEventListener("click", () => {
      latestCard = card;
      applySettings(card);
      clearPendingReferenceFile();
      if (audioUrl) {
        setBaseAudioBlob(audioBlob, "card");
        void drawAudioAnalysis(audioBlob);
      }
      log(`カードを読み込みました: ${card.name}`);
    });
    article.querySelectorAll("[data-rating]").forEach((button) => {
      button.addEventListener("click", async () => {
        const value = Number(button.dataset.rating) || 0;
        const nextRating = Number(card.rating) === value ? 0 : value;
        const saved = await saveVoiceCard({ ...card, rating: nextRating }, audioBlob);
        log(`評価を更新しました: ${saved.name} / ${nextRating || "未評価"}`);
        await renderCards();
      });
    });
    const useSourceButton = article.querySelector('[data-action="use-source"]');
    if (useSourceButton) {
      useSourceButton.addEventListener("click", () => {
        if (!audioBlob) return;
        latestCard = card;
        applySettings(card);
        clearPendingReferenceFile();
        setBaseAudioBlob(audioBlob, "card");
        void drawAudioAnalysis(audioBlob);
        setLabTab("finish");
        log(`調整元として読み込みました: ${card.name}`);
      });
    }
    article.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      await deleteVoiceCard(card.id);
      log(`カードを削除しました: ${card.name}`);
      await renderCards();
    });
    grid.appendChild(article);
  }
}

async function generateSpeech() {
  const settings = readSettings();
  saveSettings(settings);
  await prepareTextGenerationWorkspace(settings);
  setOptionalDisabled("generate", true);
  setOptionalDisabled("generateTop", true);
  $("serverStatus").textContent = "生成中";
  try {
    if (settings.seed) log(`Seed固定中: ${settings.seed}。違うテイクにしたい時はSeedのランダムを押してください。`);
    if (shouldUploadReference(settings)) {
      const voiceId = voiceIdFromFilename(referenceFile.name);
      const uploaded = await uploadReferenceVoice(settings.endpoint, referenceFile, voiceId, settings.apiKey);
      $("voice").value = uploaded.voice_id || voiceId;
      settings.voice = $("voice").value;
      clearPendingReferenceFile();
      log(`参照音声を登録しました: ${settings.voice}`);
    }

    const payload = buildSpeechPayload(settings);
    log(`生成リクエスト: ${payload.model} / ${payload.response_format} / voice=${payload.voice}`);
    const result = await synthesizeSpeech(settings);
    const cleaned = await cleanGeneratedSourceAudio(result.blob, settings);
    setBaseAudioBlob(cleaned.blob);
    latestCard = buildCard(settings, cleaned.blob, { elapsedMs: result.elapsedMs });
    await drawAudioAnalysis(cleaned.blob);
    $("serverStatus").textContent = `${result.elapsedMs}ms`;
    if (cleaned.notes.length) log(`生成後処理: ${cleaned.notes.join(" / ")}`);
    log(`生成完了: ${Math.round(cleaned.blob.size / 1024)}KB / ${result.elapsedMs}ms`);
  } catch (error) {
    $("serverStatus").textContent = "生成エラー";
    latestCard = buildCard(settings, null);
    log(error instanceof Error ? error.message : String(error));
    log("接続は維持しています。入力、参照音声、生成パラメータを確認してください。");
  } finally {
    setOptionalDisabled("generate", false);
    setOptionalDisabled("generateTop", false);
  }
}

async function generateAndSaveNewCard() {
  const settings = readSettings();
  saveSettings(settings);
  await prepareTextGenerationWorkspace(settings);
  setOptionalDisabled("generate", true);
  setOptionalDisabled("generateTop", true);
  $("serverStatus").textContent = "生成中";
  try {
    if (settings.seed) log(`Seed固定中: ${settings.seed}。違うテイクにしたい時はSeedのランダムを押してください。`);
    if (shouldUploadReference(settings)) {
      const voiceId = voiceIdFromFilename(referenceFile.name);
      const uploaded = await uploadReferenceVoice(settings.endpoint, referenceFile, voiceId, settings.apiKey);
      $("voice").value = uploaded.voice_id || voiceId;
      settings.voice = $("voice").value;
      clearPendingReferenceFile();
      log(`参照音声を登録しました: ${settings.voice}`);
    }

    const payload = buildSpeechPayload(settings);
    log(`新規カード生成: ${payload.model} / ${payload.response_format} / voice=${payload.voice}`);
    const result = await synthesizeSpeech(settings);
    const cleaned = await cleanGeneratedSourceAudio(result.blob, settings);
    setBaseAudioBlob(cleaned.blob);
    const saved = await saveVoiceCard(
      buildCard(settings, cleaned.blob, { elapsedMs: result.elapsedMs }),
      cleaned.blob,
    );
    latestCard = saved;
    await drawAudioAnalysis(cleaned.blob);
    $("serverStatus").textContent = `${result.elapsedMs}ms`;
    if (cleaned.notes.length) log(`生成後処理: ${cleaned.notes.join(" / ")}`);
    log(`新規カード保存: ${saved.name} / ${Math.round(cleaned.blob.size / 1024)}KB`);
    await renderCards();
  } catch (error) {
    $("serverStatus").textContent = "生成エラー";
    log(error instanceof Error ? error.message : String(error));
    log("生成に失敗したため、新規カードは保存していません。");
  } finally {
    setOptionalDisabled("generate", false);
    setOptionalDisabled("generateTop", false);
  }
}

async function saveSeedTakeToShelf() {
  if (!latestAudioBlob) {
    log("保存する音声がありません。先に音声を生成してください。");
    return;
  }
  const currentSettings = readSettings();
  const name = voiceWorkBaseName(latestCard?.name || cardNameFromSettings(currentSettings));
  $("saveSeedTake").disabled = true;
  try {
    $("derivedVoiceName").value = referenceNameFromVoiceWork(name);
    const savedReferenceId = await saveCurrentAudioAsDerivedReference($("derivedVoiceName").value);
    if (!savedReferenceId) return;
    const settings = readSettings();
    latestCard = buildCard(settings, latestAudioBlob, {
      id: latestCard?.id,
      name,
      elapsedMs: latestCard?.elapsedMs || null,
    });
    log(`表現音セットへ移動しました: ${name}。加工済み音声を参照音声 ${savedReferenceId} として使います。`);
    setLabTab("expression");
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
  } finally {
    $("saveSeedTake").disabled = false;
  }
}

async function applySculptToLatest() {
  const sourceBlob = latestSourceAudioBlob;
  if (!sourceBlob) {
    log(SOURCE_REQUIRED_MESSAGE);
    return;
  }
  $("applySculpt").disabled = true;
  try {
    const { playbackSpeed, processed } = await renderFixedSculptAudio();
    await playCurrentAudio({ refreshAnalysis: false });
    await drawAudioAnalysis(processed);
    log(`保存用に固定しました: 速度 ${playbackSpeed.toFixed(2)}x / ${Math.round(processed.size / 1024)}KB`);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
  } finally {
    $("applySculpt").disabled = false;
  }
}

async function renderFixedSculptAudio() {
  const sourceBlob = latestSourceAudioBlob;
  if (!sourceBlob) throw new Error(SOURCE_REQUIRED_MESSAGE);
  const settings = readSettings();
  const playbackSpeed = normalizePlaybackSpeed(settings.speed);
  let sourceForRender = sourceBlob;
  const filterMode = normalizeDeepFilterMode(settings.sculpt?.deepFilterMode);
  if (filterMode !== "off" && latestSourceKind !== `deep-filter:${filterMode}`) {
    const filtered = await applyDeepFilterToBlob(sourceForRender, settings, filterMode);
    sourceForRender = filtered.blob;
    if (filtered.applied) log(`DeepFilterNet ${filtered.mode} を固定音声へ反映しました。`);
  }
  const processed = await renderSculptedWav(sourceForRender, settings.sculpt, playbackSpeed, settings.pitch);
  latestAudioBlob = processed;
  sculptRenderDirty = false;
  latestCard = buildCard(settings, processed, {
    name: `${voiceWorkBaseName("derived")}-take`,
  });
  return { settings, playbackSpeed, processed };
}

async function applyDeepFilterToLatest() {
  const sourceBlob = latestSourceAudioBlob;
  if (!sourceBlob) {
    log(SOURCE_REQUIRED_MESSAGE);
    return;
  }
  const settings = readSettings();
  const mode = normalizeDeepFilterMode(settings.sculpt?.deepFilterMode);
  if (mode === "off") {
    log("DeepFilterNet は Off です。Light か Strong を選んでください。");
    return;
  }
  $("applyDeepFilter").disabled = true;
  $("serverStatus").textContent = "DeepFilter中";
  try {
    const filtered = await applyDeepFilterToBlob(sourceBlob, settings, mode);
    setBaseAudioBlob(filtered.blob, `deep-filter:${mode}`);
    await drawAudioAnalysis(filtered.blob);
    $("serverStatus").textContent = "処理済み";
    log(`DeepFilterNet ${mode} を試聴用音声へ反映しました: ${Math.round(filtered.blob.size / 1024)}KB`);
  } catch (error) {
    $("serverStatus").textContent = "DeepFilterエラー";
    log(error instanceof Error ? error.message : String(error));
  } finally {
    $("applyDeepFilter").disabled = false;
  }
}

async function saveCurrentAudioAsDerivedReference(rawVoiceId) {
  if (!latestAudioBlob) {
    log("保存する音声がありません。先に生成または加工してください。");
    return "";
  }
  const voiceId = sanitizeVoiceId(rawVoiceId || "nanami-reference");
  if (!voiceId) {
    log("Reference name を入力してください。");
    return "";
  }
  if (sculptRenderDirty && latestSourceAudioBlob) {
    const { processed } = await renderFixedSculptAudio();
    await drawAudioAnalysis(processed);
    log("現在のライブEQ設定を保存用音声に固定しました。");
  }
  const file = new File([latestAudioBlob], `${voiceId}.wav`, { type: "audio/wav" });
  const uploaded = await uploadReferenceVoice($("endpoint").value, file, voiceId, $("apiKey").value);
  const savedId = uploaded.voice_id || voiceId;
  $("voice").value = savedId;
  $("derivedReference").value = savedId;
  clearPendingReferenceFile();
  $("referenceStatus").textContent = `使用中: ${savedId}`;
  await loadDerivedReferences(savedId);
  updatePayloadPreview();
  return savedId;
}

async function saveLatestAsDerivedReference() {
  $("saveDerivedReference").disabled = true;
  try {
    $("derivedVoiceName").value = referenceNameFromVoiceWork("nanami-reference");
    const savedId = await saveCurrentAudioAsDerivedReference($("derivedVoiceName").value);
    if (!savedId) return;
    log(`参照音声として保存しました: ${savedId}`);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
  } finally {
    $("saveDerivedReference").disabled = false;
  }
}

async function loadDerivedReferences(selectedId = $("voice").value) {
  try {
    const voices = await fetchReferenceVoices($("endpoint").value, $("apiKey").value);
    const select = $("derivedReference");
    select.innerHTML = `<option value="none">参照なし</option>`;
    voices.forEach((voice) => {
      const option = document.createElement("option");
      option.value = voice.voice_id;
      option.textContent = voice.display_name || voice.voice_id;
      select.appendChild(option);
    });
    const normalized = voices.some((voice) => voice.voice_id === selectedId) ? selectedId : "none";
    select.value = normalized;
    $("voice").value = normalized;
    if (normalized !== "none") ensureReferenceSpeakerStrength();
    $("referenceStatus").textContent =
      normalized === "none" ? "参照音声なし" : `使用中: ${referenceVoiceLabel(voices, normalized)}`;
    renderDerivedReferenceList(voices);
  } catch (error) {
    $("derivedReferenceList").innerHTML = `<p class="hint">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
  }
}

function referenceVoiceLabel(voices, voiceId) {
  return voices.find((voice) => voice.voice_id === voiceId)?.display_name || voiceId;
}

function canDeleteReferenceVoice(voiceId) {
  return Boolean(voiceId && voiceId !== "none");
}

function syncReferenceActionButtons() {
  const voiceId = $("derivedReference")?.value || $("voice")?.value || "none";
  const hasSavedReference = Boolean(voiceId && voiceId !== "none");
  const canDelete = canDeleteReferenceVoice(voiceId);
  const downloadButton = $("downloadSelectedReference");
  const topDeleteButton = $("deleteSelectedReferenceTop");
  const sideDeleteButton = $("deleteDerivedReference");
  if (downloadButton) downloadButton.disabled = !hasSavedReference;
  if (topDeleteButton) topDeleteButton.disabled = !canDelete;
  if (sideDeleteButton) sideDeleteButton.disabled = !canDelete;
}

function renderDerivedReferenceList(voices) {
  const list = $("derivedReferenceList");
  if (!voices.length) {
    list.innerHTML = `<p class="hint">保存済み参照音声はまだありません。</p>`;
    syncReferenceActionButtons();
    return;
  }
  list.innerHTML = voices
    .map(
      (voice) => `
        <button type="button" data-voice="${escapeHtml(voice.voice_id)}">
          <strong>${escapeHtml(voice.voice_id)}</strong>
          ${voice.display_name && voice.display_name !== voice.voice_id ? `<small>${escapeHtml(voice.display_name)}</small>` : ""}
          <span>${Math.round((voice.bytes || 0) / 1024)}KB</span>
        </button>
      `,
    )
    .join("");
  list.querySelectorAll("[data-voice]").forEach((button) => {
    button.addEventListener("click", () => {
      clearPendingReferenceFile();
      selectDerivedReference(button.dataset.voice || "none");
    });
  });
  syncReferenceActionButtons();
}

function selectDerivedReference(voiceId) {
  const normalized = voiceId && voiceId !== "none" ? voiceId : "none";
  $("derivedReference").value = normalized;
  $("voice").value = normalized;
  if (normalized !== "none") ensureReferenceSpeakerStrength();
  $("referenceStatus").textContent =
    normalized === "none" ? "参照音声なし" : `使用中: ${normalized}`;
  syncReferenceActionButtons();
  updatePayloadPreview();
  saveSettings(readSettings());
}

async function downloadSelectedReferenceVoice() {
  const voiceId = $("derivedReference")?.value || $("voice")?.value || "none";
  if (!voiceId || voiceId === "none") {
    log("書き出す保存済み参照音声を選んでください。");
    return;
  }
  const button = $("downloadSelectedReference");
  if (button) button.disabled = true;
  try {
    const blob = await downloadReferenceVoice($("endpoint").value, voiceId, $("apiKey").value);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFilename(voiceId)}.wav`;
    link.click();
    URL.revokeObjectURL(url);
    log(`保存済み参照wavを書き出しました: ${voiceId}.wav`);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
  } finally {
    if (button) button.disabled = false;
  }
}

function clearPendingReferenceFile() {
  referenceFile = null;
  const picker = $("importReference");
  if (picker) picker.value = "";
}

async function loadAudioFileAsWorkbenchSource(file, sourceKind = "imported") {
  if (!file) return;
  if (file.type && !file.type.startsWith("audio/")) {
    throw new Error("音声ファイルを選んでください。");
  }
  referenceFile = file;
  $("voice").value = "none";
  $("derivedReference").value = "none";
  const baseName = syncVoiceWorkNameFromReferenceFile(file, "sculpt") || "imported-voice";
  setBaseAudioBlob(file, sourceKind);
  latestCard = buildCard(readSettings(), file, {
    name: baseName || "Imported voice",
  });
  $("referenceStatus").textContent =
    sourceKind === "recorded"
      ? `録音を加工元にしました: ${file.name}`
      : `加工元/参照候補: ${file.name}`;
  setLabTab("finish");
  updatePayloadPreview();
  saveSettings(readSettings());
  await drawAudioAnalysis(file);
  log(`音声ファイルを読み込みました: ${file.name} / ${Math.round(file.size / 1024)}KB`);
  log("この音をEQで加工して、一時保存すると参照音声として生成に使えます。");
}

async function registerReferenceFileForTextGeneration(file) {
  if (!file) return;
  if (file.type && !file.type.startsWith("audio/")) {
    throw new Error("音声ファイルを選んでください。");
  }
  syncVoiceWorkNameFromReferenceFile(file);
  const voiceId = voiceIdFromFilename(file.name);
  $("referenceStatus").textContent = `登録中: ${file.name}`;
  const uploaded = await uploadReferenceVoice($("endpoint").value, file, voiceId, $("apiKey").value);
  const savedId = uploaded.voice_id || voiceId;
  referenceFile = null;
  $("voice").value = savedId;
  $("derivedReference").value = savedId;
  clearPendingReferenceFile();
  await loadDerivedReferences(savedId);
  selectDerivedReference(savedId);
  log(`参照音声として読み込みました: ${savedId}`);
}

async function deleteSelectedDerivedReference() {
  const voiceId = $("derivedReference").value;
  if (!voiceId || voiceId === "none") {
    log("削除する参照音声を選んでください。");
    return;
  }
  if (!canDeleteReferenceVoice(voiceId)) {
    log("削除できる保存済み参照wavが選択されていません。");
    return;
  }
  const buttons = [$("deleteSelectedReferenceTop"), $("deleteDerivedReference")].filter(Boolean);
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    await deleteReferenceVoice($("endpoint").value, voiceId, $("apiKey").value);
    log(`参照音声を削除しました: ${voiceId}`);
    selectDerivedReference("none");
    await loadDerivedReferences("none");
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
  } finally {
    syncReferenceActionButtons();
  }
}

function resetBaseReference() {
  const hadImportedSource = latestSourceKind === "imported" || latestSourceKind === "recorded";
  clearPendingReferenceFile();
  selectDerivedReference("none");
  if (hadImportedSource) {
    releaseTransientAudio({ quiet: true });
    $("referenceStatus").textContent = "参照音声なし";
    $("derivedVoiceName").value = nextDerivedVoiceName();
    log("参照音声なしに戻しました。");
    return;
  }
  const baseAudioUrl = ensureBaseAudioUrl();
  if (baseAudioUrl) {
    latestAudioBlob = latestSourceAudioBlob;
    sculptRenderDirty = true;
    $("audioPlayer").src = baseAudioUrl;
    latestAudioUrl = latestBaseAudioUrl;
    applyLiveAudioSettings();
    void drawAudioAnalysis(latestSourceAudioBlob);
  }
  $("derivedVoiceName").value = nextDerivedVoiceName();
  log("参照音声なしに戻しました。");
}

function nextDerivedVoiceName() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  return `nanami-reference-${stamp}`;
}

async function decodeBlob(blob) {
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    return buffer;
  } finally {
    await context.close().catch(() => {});
  }
}

async function drawAudioAnalysis(blob) {
  const buffer = await decodeBlob(blob);
  drawWaveform(buffer, $("waveformCanvas"));
  drawHistogram(buffer, $("histogramCanvas"));
}

function dbFromAmplitude(value) {
  const amplitude = Math.max(0.000001, Number(value) || 0);
  return 20 * Math.log10(amplitude);
}

function peakTargetAmplitude(value) {
  const targetDb = normalizePeakTargetDb(value);
  if (targetDb === "off") return null;
  return 10 ** (targetDb / 20);
}

function measureAudioBufferPeak(buffer) {
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      const absolute = Math.abs(data[i]);
      if (absolute > peak) peak = absolute;
    }
  }
  return peak;
}

function applyPeakGuardToAudioBuffer(buffer, targetDb) {
  const target = peakTargetAmplitude(targetDb);
  if (!target) {
    return { applied: false, gain: 1, peakBefore: measureAudioBufferPeak(buffer), peakAfter: measureAudioBufferPeak(buffer) };
  }
  const peakBefore = measureAudioBufferPeak(buffer);
  if (peakBefore <= 0 || peakBefore <= target) {
    return { applied: false, gain: 1, peakBefore, peakAfter: peakBefore };
  }
  const gain = target / peakBefore;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) data[i] *= gain;
  }
  return { applied: true, gain, peakBefore, peakAfter: target };
}

async function applyPeakGuardToBlob(blob, targetDb) {
  if (normalizePeakTargetDb(targetDb) === "off") {
    return { blob, applied: false, peakBefore: null, peakAfter: null };
  }
  const buffer = await decodeBlob(blob);
  const result = applyPeakGuardToAudioBuffer(buffer, targetDb);
  if (!result.applied) return { blob, ...result };
  return {
    blob: new Blob([audioBufferToWav(buffer)], { type: "audio/wav" }),
    ...result,
  };
}

async function applyDeepFilterToBlob(blob, settings, mode = settings?.sculpt?.deepFilterMode) {
  const normalizedMode = normalizeDeepFilterMode(mode);
  if (normalizedMode === "off") return { blob, applied: false, mode: "off" };
  const file = new File([blob], `nanami-labo-deepfilter-${Date.now()}.wav`, { type: blob.type || "audio/wav" });
  const result = await processLabAudio(settings.endpoint, file, { deepFilterMode: normalizedMode }, settings.apiKey);
  return {
    blob: result.blob,
    applied: true,
    mode: normalizedMode,
  };
}

async function cleanGeneratedSourceAudio(rawBlob, settings) {
  const peak = await applyPeakGuardToBlob(rawBlob, settings.sculpt?.peakTargetDb);
  const notes = [];
  if (peak.applied) {
    notes.push(`Peak Guard ${dbFromAmplitude(peak.peakBefore).toFixed(1)}dB -> ${dbFromAmplitude(peak.peakAfter).toFixed(1)}dB`);
  }
  return { blob: peak.blob, notes };
}

async function renderExpressionOutputAudio(rawBlob, settings) {
  const notes = [];
  let sourceBlob = rawBlob;
  const filtered = await applyDeepFilterToBlob(sourceBlob, settings);
  sourceBlob = filtered.blob;
  if (filtered.applied) notes.push(`DeepFilterNet ${filtered.mode}`);
  const playbackSpeed = normalizePlaybackSpeed(settings.speed);
  const rendered = await renderSculptedWav(sourceBlob, settings.sculpt, playbackSpeed, settings.pitch);
  if (
    playbackSpeed !== 1 ||
    Number(settings.pitch) ||
    normalizeHpfHz(settings.sculpt?.hpfHz) ||
    normalizePeakTargetDb(settings.sculpt?.peakTargetDb) !== "off" ||
    ["gainDb", "lowDb", "midDb", "highDb", "presenceDb", "airDb"].some((key) => Math.abs(Number(settings.sculpt?.[key]) || 0) > 0.001)
  ) {
    notes.push("Sculpt固定");
  }
  return { blob: rendered, notes };
}

function monoSamples(buffer) {
  const length = buffer.length;
  const out = new Float32Array(length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) out[i] += data[i] / buffer.numberOfChannels;
  }
  return out;
}

function drawWaveform(buffer, canvas) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const samples = monoSamples(buffer);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#02080b";
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.strokeStyle = "rgba(99,246,255,.08)";
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 48) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();

  ctx.shadowColor = "rgba(99,246,255,.82)";
  ctx.shadowBlur = 14;
  ctx.strokeStyle = "#7dfaff";
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(samples.length / width));
  for (let x = 0; x < width; x += 1) {
    let min = 1;
    let max = -1;
    const start = x * step;
    for (let i = 0; i < step && start + i < samples.length; i += 1) {
      const value = samples[start + i];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const y1 = ((1 - max) * height) / 2;
    const y2 = ((1 - min) * height) / 2;
    ctx.moveTo(x, y1);
    ctx.lineTo(x, y2);
  }
  ctx.stroke();
  ctx.shadowBlur = 8;
  ctx.strokeStyle = "rgba(125,250,255,.48)";
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();
}

function drawHistogram(buffer, canvas) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const samples = monoSamples(buffer);
  const buckets = new Array(48).fill(0);
  const nearSilenceThreshold = 10 ** (-45 / 20);
  let voicedSamples = 0;
  samples.forEach((sample) => {
    const abs = Math.abs(sample);
    if (abs < nearSilenceThreshold) return;
    voicedSamples += 1;
    const normalized = (abs - nearSilenceThreshold) / Math.max(0.000001, 1 - nearSilenceThreshold);
    const index = Math.min(buckets.length - 1, Math.floor(normalized * buckets.length));
    buckets[index] += 1;
  });
  if (!voicedSamples) {
    samples.forEach((sample) => {
      const index = Math.min(buckets.length - 1, Math.floor(Math.abs(sample) * buckets.length));
      buckets[index] += 1;
    });
  }
  const max = Math.max(...buckets, 1);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#02080b";
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.strokeStyle = "rgba(99,246,255,.08)";
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 48) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
  ctx.shadowColor = "rgba(99,246,255,.72)";
  ctx.shadowBlur = 10;
  buckets.forEach((value, index) => {
    const barWidth = width / buckets.length - 3;
    const barHeight = Math.max(2, Math.sqrt(value / max) * (height - 24));
    const x = index * (width / buckets.length) + 1.5;
    const y = height - barHeight - 12;
    const gradient = ctx.createLinearGradient(0, y, 0, height);
    gradient.addColorStop(0, "#ff7ae8");
    gradient.addColorStop(0.55, "#7dfaff");
    gradient.addColorStop(1, "#1aa9bd");
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, barWidth, barHeight);
  });
}

function normalizePlaybackSpeed(speed) {
  const value = Number(speed);
  if (!Number.isFinite(value)) return 1;
  return Math.min(4, Math.max(0.25, value));
}

function pitchRatioFromSemitones(pitch) {
  const semitones = Number(pitch);
  if (!Number.isFinite(semitones)) return 1;
  return 2 ** (semitones / 12);
}

function livePlaybackRate(settings = readSettings()) {
  return normalizePlaybackSpeed(settings.speed) * pitchRatioFromSemitones(settings.pitch);
}

async function renderSculptedWav(blob, sculpt, playbackSpeed = 1, pitchSemitones = 0) {
  const inputBuffer = await decodeBlob(blob);
  const speed = normalizePlaybackSpeed(playbackSpeed) * pitchRatioFromSemitones(pitchSemitones);
  const outputLength = Math.max(1, Math.ceil(inputBuffer.length / speed));
  const offline = new OfflineAudioContext(
    inputBuffer.numberOfChannels,
    outputLength,
    inputBuffer.sampleRate,
  );
  const source = offline.createBufferSource();
  source.buffer = inputBuffer;
  source.playbackRate.value = speed;
  const hpf = offline.createBiquadFilter();
  hpf.type = "highpass";
  hpf.frequency.value = effectiveHpfFrequency(sculpt.hpfHz);
  hpf.Q.value = 0.707;
  const low = offline.createBiquadFilter();
  low.type = "lowshelf";
  low.frequency.value = 180;
  low.gain.value = Number(sculpt.lowDb) || 0;
  const mid = offline.createBiquadFilter();
  mid.type = "peaking";
  mid.frequency.value = 900;
  mid.Q.value = 0.85;
  mid.gain.value = Number(sculpt.midDb) || 0;
  const high = offline.createBiquadFilter();
  high.type = "highshelf";
  high.frequency.value = 3200;
  high.gain.value = Number(sculpt.highDb) || 0;
  const presence = offline.createBiquadFilter();
  presence.type = "peaking";
  presence.frequency.value = 4800;
  presence.Q.value = 1.2;
  presence.gain.value = Number(sculpt.presenceDb) || 0;
  const air = offline.createBiquadFilter();
  air.type = "highshelf";
  air.frequency.value = 9000;
  air.gain.value = Number(sculpt.airDb) || 0;
  const gain = offline.createGain();
  gain.gain.value = 10 ** ((Number(sculpt.gainDb) || 0) / 20);
  source.connect(hpf).connect(low).connect(mid).connect(high).connect(presence).connect(air).connect(gain).connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  applyPeakGuardToAudioBuffer(rendered, sculpt.peakTargetDb);
  return new Blob([audioBufferToWav(rendered)], { type: "audio/wav" });
}

function audioBufferToWav(buffer) {
  const samples = monoSamples(buffer);
  const dataLength = samples.length * 2;
  const arrayBuffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(arrayBuffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return arrayBuffer;
}

function writeAscii(view, offset, value) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

async function exportCardsJson() {
  const cards = await listVoiceCards();
  const blob = new Blob([JSON.stringify(cards, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `nanami-voice-cards-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function exportCurrentReferenceManifest() {
  if (acceptedExpressionItems().length && exportExpressionManifest()) return;
  if (!latestAudioBlob) {
    log("書き出す音声がありません。先に生成または加工してください。");
    return;
  }
  const settings = readSettings();
  const card = latestCard || buildCard(settings, latestAudioBlob, {
    name: voiceWorkBaseName("nanami-reference"),
  });
  const manifest = {
    kind: "nanami-voice-labo-export",
    createdAt: new Date().toISOString(),
    target: {
      referenceWav: `${safeFilename(card.name || "reference")}.wav`,
      futureSpeakerEmbedding: "checkpoint_final.speaker.safetensors",
    },
    card,
    note: "speaker.safetensors is produced by Speaker Inversion training, not by direct wav conversion.",
  };
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFilename(card.name || "nanami-reference")}-manifest.json`;
  link.click();
  URL.revokeObjectURL(url);
  log("成果物メタデータを書き出しました。");
}

function exportCurrentReferenceWav() {
  if (!latestAudioBlob) {
    log("書き出す音声がありません。先に生成または加工してください。");
    return;
  }
  const name = voiceWorkBaseName(latestCard?.name || "nanami-reference");
  const url = URL.createObjectURL(latestAudioBlob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.wav`;
  link.click();
  URL.revokeObjectURL(url);
  log(`参照wavを書き出しました: ${name}.wav`);
}

function collectAcceptedExpressionClipPayload(materialProfile = speakerMaterialProfileConfig()) {
  const expressionItems = speakerMaterialItems(materialProfile);
  const generalItems = includeGeneralSpeechSetInFinal() ? generalSpeechMaterialItems() : [];
  const items = speakerBuildItems(materialProfile);
  if (items.length < 2) {
    throw new Error(`${materialProfile.label}の学習用wavが足りません。表現音を2件以上採用するか、一般音声100を生成して含めてください。`);
  }
  const missing = [];
  const files = items.map((item, index) => {
    const blob = materialAudioBlob(item);
    if (!blob) missing.push(`${item.sourceKind === "general" ? "一般" : "表現"} ${String(item.order + 1).padStart(3, "0")} ${item.categoryLabel}`);
    return {
      field: `audio_${index}`,
      filename: materialItemFilename(item),
      item,
      blob,
    };
  });
  if (missing.length) {
    throw new Error(`採用済みですが音声Blobがありません。再生成してください: ${missing.slice(0, 6).join(", ")}`);
  }
  return {
    items,
    files,
    materialProfile,
    expressionCount: expressionItems.length,
    generalCount: generalItems.length,
  };
}

function speakerBuildModeConfig({ sampleCount = 0, generalCount = 0 } = {}) {
  const mode = $("speakerBuildMode")?.value || "standard";
  if (mode === "smoke") return { mode, smoke: true, maxSteps: 1, label: "スモーク" };
  if (mode === "production") return { mode, smoke: false, maxSteps: 3000, label: "本番" };
  const maxSteps = recommendedSpeakerBuildSteps(sampleCount);
  return { mode: "standard", smoke: false, maxSteps, label: "標準" };
}

function setSpeakerBuildStatus(message, state = "") {
  const status = $("speakerBuildStatus");
  if (!status) return;
  status.textContent = message;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
}

function setSpeakerBuildLog(text = "") {
  const logArea = $("speakerBuildLog");
  if (!logArea) return;
  logArea.textContent = text || "";
  logArea.scrollTop = logArea.scrollHeight;
}

function stopSpeakerBuildPolling() {
  if (speakerBuildPollTimer) {
    clearTimeout(speakerBuildPollTimer);
    speakerBuildPollTimer = 0;
  }
}

function setSpeakerBuildControlsRunning(running) {
  const buildButton = $("buildSpeakerEmbedding");
  const cancelButton = $("cancelSpeakerBuild");
  if (buildButton) {
    buildButton.disabled = running;
    buildButton.textContent = running ? "作成中..." : "最終成果物を作成";
  }
  if (cancelButton) cancelButton.disabled = !running;
}

function terminalSpeakerJobStatus(status) {
  return ["completed", "failed", "cancelled", "dry_run"].includes(status);
}

function renderSpeakerBuildJob(job) {
  const status = String(job?.status || "");
  const phase = String(job?.phase || status || "-");
  const sampleCount = Number(job?.sample_count || 0);
  if (status === "completed") {
    setSpeakerBuildStatus(`最終成果物を作成しました。採用素材 ${sampleCount} 件を成果物テストへ追加しました。`, "completed");
  } else if (status === "failed") {
    setSpeakerBuildStatus(`最終成果物の作成に失敗しました: ${job?.error || "ログを確認してください。"}`, "failed");
  } else if (status === "cancelled") {
    setSpeakerBuildStatus("最終成果物の作成を中止しました。成果物カードは追加していません。", "cancelled");
  } else if (status === "dry_run") {
    setSpeakerBuildStatus(`ドライラン完了: ${sampleCount}件の素材を検証しました。`, "completed");
  } else {
    setSpeakerBuildStatus(`Speaker Inversion実行中: ${phase} / 採用素材 ${sampleCount}件 / job ${job?.job_id || "-"}`, "running");
  }
  setSpeakerBuildLog(job?.logTail || "");
  setSpeakerBuildControlsRunning(!terminalSpeakerJobStatus(status));
}

async function pollSpeakerBuildJob(jobId) {
  stopSpeakerBuildPolling();
  if (!jobId) return;
  try {
    const job = await fetchSpeakerInversionJob($("endpoint").value, jobId, $("apiKey").value);
    speakerBuildPollErrorCount = 0;
    renderSpeakerBuildJob(job);
    if (job.status === "completed") {
      activeSpeakerBuildJobId = "";
      speakerBuildPollErrorCount = 0;
      await loadFinalArtifacts();
      if (job.artifact?.artifact_id) {
        activeFinalArtifactId = job.artifact.artifact_id;
        renderFinalArtifacts();
        renderFinalArtifactEditPanel();
      }
      setLabTab("test");
      log(`最終成果物を作成し、.runtime/final_artifacts に保存しました: ${job.artifact?.display_name || job.artifact?.artifact_id || jobId}`);
      return;
    }
    if (terminalSpeakerJobStatus(job.status)) {
      activeSpeakerBuildJobId = "";
      speakerBuildPollErrorCount = 0;
      return;
    }
    speakerBuildPollTimer = setTimeout(() => void pollSpeakerBuildJob(jobId), 2200);
  } catch (error) {
    speakerBuildPollErrorCount += 1;
    const message = error instanceof Error ? error.message : String(error);
    if (speakerBuildPollErrorCount >= SPEAKER_BUILD_POLL_MAX_ERRORS) {
      setSpeakerBuildStatus(message, "failed");
      setSpeakerBuildControlsRunning(false);
      log(message);
      return;
    }
    setSpeakerBuildStatus(`Speaker Inversion更新待ち: 通信リトライ ${speakerBuildPollErrorCount}/${SPEAKER_BUILD_POLL_MAX_ERRORS}。学習本体は継続している可能性があります。`, "running");
    setSpeakerBuildControlsRunning(true);
    log(`Speaker Inversion更新待ち: ${message}`);
    speakerBuildPollTimer = setTimeout(() => void pollSpeakerBuildJob(jobId), 3000);
  }
}

async function createSpeakerEmbeddingBuild() {
  const materialProfile = speakerMaterialProfileConfig();
  setSpeakerBuildControlsRunning(true);
  if (includeGeneralSpeechSetInFinal()) {
    setSpeakerBuildStatus(`一般音声100を確認しています。未生成分があればここで作成します。`, "running");
    await ensureGeneralSpeechSetGenerated();
  }
  const { items, files, expressionCount, generalCount } = collectAcceptedExpressionClipPayload(materialProfile);
  const mode = speakerBuildModeConfig({ sampleCount: items.length, generalCount });
  const defaultName = `nanami-speaker-${materialProfile.suffix}-${new Date().toISOString().slice(0, 10)}`;
  const baseName = voiceWorkBaseName(defaultName);
  const artifactId = safeFilename(`${baseName}-${Date.now().toString(36)}`).slice(0, 72);
  const form = new FormData();
  form.append("artifact_id", artifactId);
  form.append("display_name", baseName || artifactId);
  form.append("description", `${baseName || artifactId}: NANAMI VOICE LABOで表現音 ${expressionCount}件、一般音声 ${generalCount}件から作成。${materialProfile.label} / ${mode.label}`);
  form.append("mode", mode.mode);
  form.append("smoke", String(mode.smoke));
  form.append("max_steps", String(mode.maxSteps));
  form.append("device", $("speakerBuildDevice")?.value || "cpu");
  form.append("manifest", JSON.stringify(buildExpressionManifestData(items, materialProfile)));
  form.append(
    "items",
    JSON.stringify(
      files.map(({ field, filename, item }) => ({
        field,
        filename,
        text: item.text,
        caption: item.caption,
        voiceGender: item.voiceGender || currentExpressionGender(),
        voiceCaption: item.voiceCaption || "",
        sourceKind: item.sourceKind || "expression",
        category: item.category,
        categoryLabel: item.categoryLabel,
        status: item.status,
        seed: item.seed,
        materialProfile: materialProfile.id,
      })),
    ),
  );
  files.forEach(({ field, filename, blob }) => {
    form.append(field, blob, filename);
  });

  stopSpeakerBuildPolling();
  speakerBuildPollErrorCount = 0;
  setSpeakerBuildControlsRunning(true);
  setSpeakerBuildStatus(`${materialProfile.label}の学習素材 ${items.length}件をbridgeへ送信中... 表現音 ${expressionCount}件 / 一般音声 ${generalCount}件`, "running");
  setSpeakerBuildLog("");
  const job = await createSpeakerInversionJob($("endpoint").value, form, $("apiKey").value);
  activeSpeakerBuildJobId = job.job_id || "";
  renderSpeakerBuildJob(job);
  log(`Speaker Inversionジョブを開始しました: ${activeSpeakerBuildJobId} / ${materialProfile.label} / ${mode.label}`);
  if (activeSpeakerBuildJobId && !terminalSpeakerJobStatus(job.status)) {
    speakerBuildPollTimer = setTimeout(() => void pollSpeakerBuildJob(activeSpeakerBuildJobId), 1600);
  }
}

async function cancelActiveSpeakerBuild() {
  if (!activeSpeakerBuildJobId) {
    log("実行中のSpeaker Inversionジョブはありません。");
    return;
  }
  setSpeakerBuildStatus("中止を要求しました。現在の処理が止まるまで待っています。", "running");
  const job = await cancelSpeakerInversionJob($("endpoint").value, activeSpeakerBuildJobId, $("apiKey").value);
  renderSpeakerBuildJob(job);
  activeSpeakerBuildJobId = "";
  stopSpeakerBuildPolling();
}

async function downloadActiveFinalArtifact() {
  const artifact = activeFinalArtifact();
  if (!artifact) {
    log("保存する成果物を選んでください。");
    return;
  }
  if (!artifact.bytes || artifact.bytes <= 0) {
    log("有効なsafetensorsを持つ完成カードだけ保存できます。");
    return;
  }
  const blob = await downloadFinalArtifactCheckpoint($("endpoint").value, artifact.artifact_id, $("apiKey").value);
  const name = `${safeFilename(artifact.display_name || artifact.artifact_id)}.speaker.safetensors`;
  downloadBlob(blob, name);
  log(`safetensorsを書き出しました: ${name}`);
}

async function toggleRecording() {
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
    $("recordReference").textContent = "録音";
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  recordingChunks = [];
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) recordingChunks.push(event.data);
  };
  mediaRecorder.onstop = () => {
    stream.getTracks().forEach((track) => track.stop());
    referenceFile = new File(recordingChunks, `recorded-${Date.now()}.webm`, { type: "audio/webm" });
    void loadAudioFileAsWorkbenchSource(referenceFile, "recorded").catch((error) => {
      $("referenceStatus").textContent = `録音を参照音声にしました: ${referenceFile.name}`;
      $("voice").value = "none";
      updatePayloadPreview();
      log(error instanceof Error ? error.message : String(error));
    });
  };
  mediaRecorder.start();
  $("recordReference").textContent = "停止";
  $("referenceStatus").textContent = "録音中...";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeFilename(value) {
  return String(value || "voice")
    .normalize("NFKC")
    .replace(/[^\w\-ぁ-んァ-ン一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "voice";
}

function voiceWorkBaseName(fallback = "nanami-reference") {
  const seedName = safeFilename($("seedTakeName")?.value || "");
  if (seedName && seedName !== "voice") return seedName;
  const derivedName = safeFilename($("derivedVoiceName")?.value || "");
  if (derivedName && derivedName !== "voice") return derivedName;
  return safeFilename(latestCard?.name || fallback);
}

function referenceNameFromVoiceWork(fallback = "nanami-reference") {
  const baseName = voiceWorkBaseName(fallback);
  return baseName.endsWith("-reference") ? baseName : `${baseName}-reference`;
}

function syncVoiceWorkNameFromReferenceFile(file, suffix = "reference") {
  const rawName = String(file?.name || "").replace(/\.[^.]+$/, "").trim();
  if (!rawName) return "";
  const baseName = safeFilename(rawName);
  if ($("seedTakeName")) $("seedTakeName").value = baseName;
  if ($("derivedVoiceName")) $("derivedVoiceName").value = `${baseName}-${suffix}`;
  return baseName;
}

function sanitizeVoiceId(value) {
  return safeFilename(value).slice(0, 48);
}

fields.forEach((field) => {
  const handleFieldInput = () => {
    updateSliderLabels();
    updatePayloadPreview();
    saveSettings(readSettings());
    if (liveSculptFields.has(field)) {
      sculptRenderDirty = true;
      applyLiveAudioSettings();
    }
    if (field === "seed") {
      expressionSeedBase = "";
      syncSeedQuickInput();
    }
    if (field === "endpoint") scheduleBridgeRefresh();
  };
  $(field).addEventListener("input", handleFieldInput);
  $(field).addEventListener("change", handleFieldInput);
});

document.querySelectorAll("[data-lab-tab-target]").forEach((button) => {
  button.addEventListener("click", () => setLabTab(button.dataset.labTabTarget));
});

document.querySelectorAll("[data-seed-quality]").forEach((button) => {
  button.addEventListener("click", () => applySeedQuality(button.dataset.seedQuality));
});

document.querySelectorAll("[data-hpf-hz]").forEach((button) => {
  button.addEventListener("click", () => setHpfPreset(button.dataset.hpfHz));
});

document.querySelectorAll("[data-peak-target-db]").forEach((button) => {
  button.addEventListener("click", () => setPeakGuardPreset(button.dataset.peakTargetDb));
});

document.querySelectorAll("[data-deep-filter-mode]").forEach((button) => {
  button.addEventListener("click", () => setDeepFilterMode(button.dataset.deepFilterMode));
});

$("seedQuick")?.addEventListener("input", () => {
  $("seed").value = $("seedQuick").value;
  expressionSeedBase = "";
  updatePayloadPreview();
  saveSettings(readSettings());
});
$("clearSeed")?.addEventListener("click", () => {
  $("seed").value = "";
  $("seedQuick").value = "";
  expressionSeedBase = "";
  updatePayloadPreview();
  saveSettings(readSettings());
  log("Seedをランダムに戻しました。次の生成は別テイクになります。");
});

$("importReference").addEventListener("change", (event) => {
  const file = event.target.files?.[0] || null;
  if (!file) return;
  void registerReferenceFileForTextGeneration(file).catch((error) => {
    referenceFile = null;
    clearPendingReferenceFile();
    $("referenceStatus").textContent = "参照音声の読み込みに失敗しました";
    $("voice").value = "none";
    $("derivedReference").value = "none";
    updatePayloadPreview();
    log(error instanceof Error ? error.message : String(error));
  });
});
$("recordReference").addEventListener("click", () => {
  toggleRecording().catch((error) => log(error instanceof Error ? error.message : String(error)));
});
document.querySelectorAll("[data-script-length]").forEach((button) => {
  button.addEventListener("click", () => setScriptLength(button.dataset.scriptLength));
});
$("draftLine").addEventListener("click", () => void draftScriptLine());
$("generate")?.addEventListener("click", () => void generateAndSaveNewCard());
$("saveSeedTake")?.addEventListener("click", () => void saveSeedTakeToShelf());
$("regenerateAdjusted")?.addEventListener("click", () => void generateSpeech());
$("generateTop")?.addEventListener("click", () => void generateSpeech());
$("expressionLimit")?.addEventListener("input", () => setExpressionLimit(readExpressionLimit()));
document.addEventListener("click", (event) => {
  const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
  const button = target?.closest?.("button");
  if (!button) return;
  if (button.dataset.expressionLimit) {
    setExpressionLimit(button.dataset.expressionLimit);
    buildExpressionQueue();
    return;
  }
  const actions = {
    buildExpressionQueue: () => buildExpressionQueue(),
    generateNextExpression: () => {
      log("次の候補を生成します。");
      void generateNextExpressionCandidate().catch((error) => log(error instanceof Error ? error.message : String(error)));
    },
    generateAllExpressions: () => {
      log("未生成候補の連続生成を開始します。");
      void generateAllExpressionCandidates().catch((error) => log(error instanceof Error ? error.message : String(error)));
    },
    generateCustomExpression: () => {
      log("自作表現を生成します。");
      void generateCustomExpressionCandidate().catch((error) => log(error instanceof Error ? error.message : String(error)));
    },
    generateGeneralSpeechSet: () => {
      log("一般音声100の生成を開始します。");
      void ensureGeneralSpeechSetGenerated({ force: true }).catch((error) => log(error instanceof Error ? error.message : String(error)));
    },
    clearGeneralSpeechSet,
    stopExpressionBatch,
    acceptExpression: () => setActiveExpressionStatus("accepted", { advance: true }),
    soundOnlyExpression: () => setActiveExpressionStatus("soundOnly", { advance: true }),
    holdExpression: () => setActiveExpressionStatus("hold", { advance: true }),
    recordingNeededExpression: () => setActiveExpressionStatus("recording"),
    rejectExpression: () => setActiveExpressionStatus("rejected", { advance: true }),
    regenerateExpression: () => {
      log("選択中の候補を再生成します。");
      void regenerateActiveExpressionCandidate().catch((error) => log(error instanceof Error ? error.message : String(error)));
    },
    nextReviewExpression: selectNextReviewCandidate,
    downloadAcceptedWavs: () => {
      void downloadAcceptedExpressionWavs().catch((error) => log(error instanceof Error ? error.message : String(error)));
    },
    downloadReviewAnalysis: () => {
      void downloadGeneratedExpressionAnalysisZip().catch((error) => log(error instanceof Error ? error.message : String(error)));
    },
    exportTrainingJsonl,
  };
  actions[button.id]?.();
});
document.querySelectorAll("[data-clear-expression-set]").forEach((button) => {
  button.addEventListener("click", resetExpressionQueue);
});
$("playPreview")?.addEventListener("click", () => {
  const player = $("audioPlayer");
  if (liveAudioSource || (!player.paused && !player.ended)) {
    player.pause();
    stopLiveAudioSource();
    syncPlaybackButtonState();
    return;
  }
  void playCurrentAudio().catch((error) => {
    syncPlaybackButtonState();
    log(error instanceof Error ? error.message : String(error));
  });
});
$("audioPlayer")?.addEventListener("play", syncPlaybackButtonState);
$("audioPlayer")?.addEventListener("pause", syncPlaybackButtonState);
$("audioPlayer")?.addEventListener("ended", syncPlaybackButtonState);
$("clearTransientAudio")?.addEventListener("click", () => void clearTransientAudio());
$("resetTextGeneration")?.addEventListener("click", resetTextGenerationDefaults);
$("resetTextGenerationTop")?.addEventListener("click", resetTextGenerationDefaults);
$("resetSculpt")?.addEventListener("click", resetSculptControls);
$("applySculpt").addEventListener("click", () => void applySculptToLatest());
$("applyDeepFilter")?.addEventListener("click", () => void applyDeepFilterToLatest());
$("saveDerivedReference").addEventListener("click", () => void saveLatestAsDerivedReference());
$("resetBaseReference").addEventListener("click", resetBaseReference);
$("downloadSelectedReference")?.addEventListener("click", () => {
  void downloadSelectedReferenceVoice();
});
$("deleteSelectedReferenceTop")?.addEventListener("click", () => void deleteSelectedDerivedReference());
$("derivedReference").addEventListener("change", () => {
  clearPendingReferenceFile();
  selectDerivedReference($("derivedReference").value);
});
$("deleteDerivedReference").addEventListener("click", () => void deleteSelectedDerivedReference());
$("exportJson").addEventListener("click", () => void exportCardsJson());
$("exportReferenceWav")?.addEventListener("click", exportCurrentReferenceWav);
$("exportManifest")?.addEventListener("click", exportCurrentReferenceManifest);
$("speakerMaterialProfile")?.addEventListener("change", updateSpeakerMaterialProfileHint);
$("includeGeneralSpeechSet")?.addEventListener("change", () => {
  renderGeneralSpeechStatus();
  updateSpeakerMaterialProfileHint();
});
$("buildSpeakerEmbedding")?.addEventListener("click", () => {
  void createSpeakerEmbeddingBuild().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    setSpeakerBuildControlsRunning(false);
    setSpeakerBuildStatus(message, "failed");
    log(message);
  });
});
$("cancelSpeakerBuild")?.addEventListener("click", () => {
  void cancelActiveSpeakerBuild().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    setSpeakerBuildStatus(message, "failed");
    log(message);
  });
});
$("saveFinalArtifactDescription")?.addEventListener("click", saveFinalArtifactDescription);
$("cancelFinalArtifactDescription")?.addEventListener("click", cancelFinalArtifactCardEdit);
$("finalArtifactDescription")?.addEventListener("input", () => {
  if (editingFinalArtifactId) renderFinalArtifacts();
});
$("downloadFinalArtifact")?.addEventListener("click", () => {
  void downloadActiveFinalArtifact().catch((error) => log(error instanceof Error ? error.message : String(error)));
});
$("hideFinalArtifactCard")?.addEventListener("click", hideActiveFinalArtifactCard);
$("deleteFinalArtifactFiles")?.addEventListener("click", () => {
  void deleteActiveFinalArtifactFiles();
});
$("generateFinalArtifactTest")?.addEventListener("click", () => {
  void generateFinalArtifactTest().catch((error) => log(error instanceof Error ? error.message : String(error)));
});
$("refreshBridge").addEventListener("click", () => void refreshBridgeInfo());

const savedSettings = migrateSettings(loadSettings());
renderModelOptions();
applySettings(savedSettings);
saveSettings(readSettings());
if (!savedSettings.seedQuality) seedQuality = inferSeedQualityFromSettings();
if ($("seed").value === "1234") $("seed").value = "";
$("voiceCaption").placeholder = DEFAULT_VOICE_CAPTION;
setScriptLength(savedSettings.scriptLength || "short");
setLabTab("seed");
renderVoiceCaptionPresets();
syncSeedQuickInput();
updateSpeakerMaterialProfileHint();
syncSeedQualityButtons();
updateSliderLabels();
updatePayloadPreview();
syncPlaybackButtonState();
renderExpressionWorkflow();
renderGeneralSpeechStatus();
void refreshBridgeInfo({ quiet: true });
void loadFinalArtifacts();
renderCards().catch((error) => log(error instanceof Error ? error.message : String(error)));
void loadDerivedReferences($("voice").value);

globalThis.addEventListener("pagehide", cleanupTransientAudioOnClose);
globalThis.addEventListener("beforeunload", cleanupTransientAudioOnClose);
