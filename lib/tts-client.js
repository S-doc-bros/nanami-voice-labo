const DEFAULT_TIMEOUT_MS = 300_000;
const BRIDGE_INFO_TIMEOUT_MS = 2_500;
const DEFAULT_DURATION_SCALE = 1.0;
const DEFAULT_MAX_SECONDS = 45;
const DEFAULT_REFERENCE_CFG_SPEAKER = 4.0;

export const DEFAULT_MODEL = "irodori-v3-lab-engine";
export const DEFAULT_IRODORI_DURATION_SCALE = DEFAULT_DURATION_SCALE;

export const FALLBACK_MODELS = [
  { id: "irodori-v3-lab-engine", label: "Nanami Labo 600M v3 VoiceDesign", mode: "voice-design" },
  { id: "irodori-voice-design-600m-v3", label: "600M v3 VoiceDesign", mode: "voice-design" },
  { id: "irodori-lite-auto", label: "Lite 自動", mode: "auto" },
];

export function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("TTS API URLを入力してください。");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function bridgeRootUrl(baseUrl) {
  return normalizeBaseUrl(baseUrl).replace(/\/v1$/, "");
}

function withTimeout(options = {}) {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), options.timeoutMs || BRIDGE_INFO_TIMEOUT_MS);
  return { controller, timeout };
}

async function fetchJson(url, options = {}) {
  const fetcher = options.fetchImpl || fetch;
  const { controller, timeout } = withTimeout(options);
  try {
    const response = await fetcher(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function fetchBridgeInfo(endpoint, options = {}) {
  const baseUrl = normalizeBaseUrl(endpoint);
  const rootUrl = bridgeRootUrl(endpoint);
  const [healthResult, modelsResult] = await Promise.allSettled([
    fetchJson(`${rootUrl}/health`, options),
    fetchJson(`${baseUrl}/models`, options),
  ]);

  const health = healthResult.status === "fulfilled" ? healthResult.value : null;
  const modelsPayload = modelsResult.status === "fulfilled" ? modelsResult.value : null;
  const models = Array.isArray(modelsPayload?.data)
    ? modelsPayload.data.map((model) => ({
        id: model.id,
        label: model.label || model.id,
        mode: model.mode || "local",
      }))
    : [];
  const errors = [healthResult, modelsResult]
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message || String(result.reason));

  return {
    ok: errors.length === 0,
    reachable: Boolean(health || modelsPayload),
    ready: Boolean(health?.ready ?? health?.ok ?? models.length),
    engine: health?.engine || "irodori-openai-bridge",
    message: health?.message || (errors.length ? errors.join(" / ") : "ready"),
    models,
    rawHealth: health,
  };
}

export function buildSpeechPayload(settings) {
  const input = String(settings.text || "").trim();
  if (!input) throw new Error("読み上げる本文を入力してください。");
  const hasReferenceVoice = Boolean(settings.voice && settings.voice !== "none");
  const hasFinalArtifact = Boolean(String(settings.finalArtifactId || "").trim());
  const hasSpeakerCondition = hasReferenceVoice || hasFinalArtifact;
  const requestedCfgSpeaker = Number(settings.cfgSpeaker);
  const cfgSpeaker =
    Number.isFinite(requestedCfgSpeaker) && requestedCfgSpeaker > 0
      ? requestedCfgSpeaker
      : DEFAULT_REFERENCE_CFG_SPEAKER;

  const irodori = {
    num_steps: Number(settings.numSteps),
    cfg_guidance_mode: settings.cfgMode || "independent",
    cfg_scale_text: Number(settings.cfgText),
    cfg_scale_caption: Number.isFinite(Number(settings.cfgCaption))
      ? Number(settings.cfgCaption)
      : Number(settings.cfgText),
    cfg_scale_speaker: hasSpeakerCondition ? cfgSpeaker : 0,
    t_schedule_mode: settings.scheduleMode || "sway",
    sway_coeff: Number(settings.swayCoeff),
    duration_scale: Number.isFinite(Number(settings.durationScale))
      ? Number(settings.durationScale)
      : DEFAULT_DURATION_SCALE,
    max_seconds: DEFAULT_MAX_SECONDS,
    chunking_enabled: true,
    ...(settings.trimTail !== undefined ? { trim_tail: Boolean(settings.trimTail) } : {}),
  };
  const seedValue = String(settings.seed ?? "").trim();
  if (seedValue) irodori.seed = Number(seedValue);

  Object.keys(irodori).forEach((key) => {
    const value = irodori[key];
    if (typeof value === "number" && !Number.isFinite(value)) delete irodori[key];
  });

  if (String(settings.caption || "").trim()) {
    irodori.caption = String(settings.caption).trim();
  }
  if (String(settings.finalArtifactId || "").trim()) {
    irodori.final_artifact_id = String(settings.finalArtifactId).trim();
  }

  return {
    model: settings.model || DEFAULT_MODEL,
    input,
    voice: settings.voice || "none",
    response_format: String(settings.format || "wav").toLowerCase(),
    speed: 1,
    pitch: 0,
    irodori,
  };
}

export async function synthesizeSpeech(settings, options = {}) {
  const baseUrl = normalizeBaseUrl(settings.endpoint);
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const startedAt = performance.now();

  try {
    const response = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
      },
      body: JSON.stringify(buildSpeechPayload(settings)),
      signal: controller.signal,
    });

    const elapsedMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`TTS生成に失敗しました: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
    }

    return {
      blob: await response.blob(),
      elapsedMs,
      contentType: response.headers.get("content-type") || `audio/${settings.format || "wav"}`,
    };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function fetchFinalArtifacts(endpoint, apiKey = "") {
  const baseUrl = normalizeBaseUrl(endpoint);
  const response = await fetch(`${baseUrl.replace(/\/v1$/, "")}/v1/lab/final-artifacts`, {
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`成果物一覧を取得できませんでした: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
  }
  const payload = await response.json();
  return Array.isArray(payload?.data) ? payload.data : [];
}

export async function createSpeakerInversionJob(endpoint, formData, apiKey = "") {
  const rootUrl = bridgeRootUrl(endpoint);
  const response = await fetch(`${rootUrl}/v1/lab/speaker-inversion/jobs`, {
    method: "POST",
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: formData,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Speaker Inversionジョブを開始できませんでした: HTTP ${response.status}`);
  }
  return payload;
}

export async function fetchSpeakerInversionJob(endpoint, jobId, apiKey = "") {
  const rootUrl = bridgeRootUrl(endpoint);
  const response = await fetch(`${rootUrl}/v1/lab/speaker-inversion/jobs/${encodeURIComponent(jobId)}`, {
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Speaker Inversionジョブを取得できませんでした: HTTP ${response.status}`);
  }
  return payload;
}

export async function cancelSpeakerInversionJob(endpoint, jobId, apiKey = "") {
  const rootUrl = bridgeRootUrl(endpoint);
  const response = await fetch(`${rootUrl}/v1/lab/speaker-inversion/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Speaker Inversionジョブを中止できませんでした: HTTP ${response.status}`);
  }
  return payload;
}

export async function downloadFinalArtifactCheckpoint(endpoint, artifactId, apiKey = "") {
  const rootUrl = bridgeRootUrl(endpoint);
  const response = await fetch(`${rootUrl}/v1/lab/final-artifacts/${encodeURIComponent(artifactId)}/checkpoint`, {
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`safetensorsを取得できませんでした: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
  }
  return response.blob();
}

export async function deleteFinalArtifact(endpoint, artifactId, apiKey = "") {
  const rootUrl = bridgeRootUrl(endpoint);
  const response = await fetch(`${rootUrl}/v1/lab/final-artifacts/${encodeURIComponent(artifactId)}`, {
    method: "DELETE",
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `成果物を削除できませんでした: HTTP ${response.status}`);
  }
  return payload;
}

export async function uploadReferenceVoice(endpoint, file, voiceId, apiKey = "") {
  if (!file) throw new Error("参照音声ファイルを選んでください。");
  const baseUrl = normalizeBaseUrl(endpoint);
  const form = new FormData();
  form.append("file", file);
  form.append("voice_id", voiceId || voiceIdFromFilename(file.name));

  const response = await fetch(`${baseUrl}/audio/voices`, {
    method: "POST",
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: form,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`参照音声を登録できませんでした: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
  }
  return response.json().catch(() => ({ voice_id: voiceId || voiceIdFromFilename(file.name) }));
}

export async function processLabAudio(endpoint, file, options = {}, apiKey = "") {
  if (!file) throw new Error("処理する音声がありません。");
  const rootUrl = bridgeRootUrl(endpoint);
  const form = new FormData();
  form.append("file", file);
  form.append("deep_filter_mode", options.deepFilterMode || "off");

  const response = await fetch(`${rootUrl}/v1/lab/audio/process`, {
    method: "POST",
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: form,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`音声処理に失敗しました: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
  }
  return {
    blob: await response.blob(),
    contentType: response.headers.get("content-type") || "audio/wav",
  };
}

export async function fetchReferenceVoices(endpoint, apiKey = "") {
  const baseUrl = normalizeBaseUrl(endpoint);
  const response = await fetch(`${baseUrl}/audio/voices`, {
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`参照音声一覧を取得できませんでした: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
  }
  const payload = await response.json();
  return Array.isArray(payload?.data) ? payload.data : [];
}

export async function downloadReferenceVoice(endpoint, voiceId, apiKey = "") {
  const baseUrl = normalizeBaseUrl(endpoint);
  const safeId = encodeURIComponent(String(voiceId || "").trim());
  if (!safeId || voiceId === "none") throw new Error("書き出す保存済み参照音声を選んでください。");
  const response = await fetch(`${baseUrl}/audio/voices/${safeId}/download`, {
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`参照wavを取得できませんでした: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
  }
  return response.blob();
}

export async function deleteReferenceVoice(endpoint, voiceId, apiKey = "") {
  const baseUrl = normalizeBaseUrl(endpoint);
  const safeId = encodeURIComponent(String(voiceId || "").trim());
  if (!safeId) throw new Error("削除する参照音声を選んでください。");
  const response = await fetch(`${baseUrl}/audio/voices/${safeId}`, {
    method: "DELETE",
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`参照音声を削除できませんでした: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
  }
  return response.json();
}

export function voiceIdFromFilename(filename) {
  return String(filename || "reference")
    .replace(/\.[^.]+$/, "")
    .normalize("NFKC")
    .replace(/[^\w\-ぁ-んァ-ン一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "reference";
}
