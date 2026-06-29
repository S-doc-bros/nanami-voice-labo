from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


def test_generation_payload_uses_45_second_max_duration():
    client = read("lib/tts-client.js")
    bridge = read("irodori_openai_bridge.py")
    engine = read("lab_v3_engine_server.py")

    assert "DEFAULT_MAX_SECONDS = 45" in client
    assert "max_seconds: DEFAULT_MAX_SECONDS" in client
    assert '"max_seconds"' in bridge
    assert '("max_seconds", "--max-seconds")' in bridge
    assert '"max_seconds": _optional_float(body, "max_seconds", 45.0)' in engine


def test_expression_sets_are_gendered_and_include_power_shout():
    app = read("app.js")

    assert "FEMALE_EXPRESSION_CATEGORIES" in app
    assert "MALE_EXPRESSION_CATEGORIES" in app
    assert "EXPRESSION_CATEGORY_SETS" in app
    assert 'id: "power_shout"' in app
    assert 'label: "強い叫び"' in app
    assert "ウオォォォォォォォ" in app
    assert "ふざけるなぁぁぁ" in app


def test_custom_expression_generation_controls_exist():
    index = read("index.html")
    app = read("app.js")

    assert 'id="customExpressionText"' in index
    assert 'id="generateCustomExpression"' in index
    assert "function generateCustomExpressionCandidate" in app


def test_general_speech_set_can_be_added_to_final_artifact():
    index = read("index.html")
    app = read("app.js")

    assert 'id="includeGeneralSpeechSet" type="checkbox"' in index
    assert 'id="includeGeneralSpeechSet" type="checkbox" checked' not in index
    assert 'id="generateGeneralSpeechSet"' in index
    assert 'id="generalSpeechStatus"' in index
    assert "GENERAL_SPEECH_TARGET_COUNT = 100" in app
    assert "function buildGeneralSpeechQueueItems" in app
    assert "async function ensureGeneralSpeechSetGenerated" in app
    assert "function speakerBuildItems" in app
    assert "includeGeneralSpeechSet" in app


def test_general_speech_batch_retries_and_continues_after_transient_fetch_errors():
    app = read("app.js")

    assert "GENERAL_SPEECH_MAX_RETRIES = 2" in app
    assert "function isTransientFetchError" in app
    assert "一般音声通信リトライ" in app
    assert "let consecutiveFailures = 0" in app
    assert "consecutiveFailures >= 3" in app
    assert "一般音声の連続エラーで停止しました" in app


def test_speaker_build_polling_recovers_from_temporary_fetch_errors():
    app = read("app.js")

    assert "SPEAKER_BUILD_POLL_MAX_ERRORS = 5" in app
    assert "let speakerBuildPollErrorCount = 0" in app
    assert "speakerBuildPollErrorCount = 0;" in app
    assert "Speaker Inversion更新待ち" in app
    assert "speakerBuildPollErrorCount >= SPEAKER_BUILD_POLL_MAX_ERRORS" in app


def test_final_artifact_test_uses_stable_ref_embed_settings_without_live_eq():
    app = read("app.js")
    client = read("lib/tts-client.js")
    index = read("index.html")

    assert "FINAL_ARTIFACT_TEST_SETTINGS" in app
    assert 'FINAL_ARTIFACT_TEST_MODEL = "irodori-nanami-final-500m"' in app
    assert "numSteps: 24" in app
    assert 'cfgMode: "independent"' in app
    assert "cfgText: 1.0" in app
    assert "cfgCaption: 1.0" in app
    assert "cfgSpeaker: 1.0" in app
    assert "durationScale: 1.0" in app
    assert "trimTail: true" in app
    assert 'scheduleMode: "linear"' in app
    assert "trim_tail: Boolean(settings.trimTail)" in client
    assert "...FINAL_ARTIFACT_TEST_SETTINGS" in app
    assert "model: FINAL_ARTIFACT_TEST_MODEL" in app
    assert 'model: artifact.model || "irodori-nanami-final-500m"' not in app
    assert 'latestSourceKind === "final-artifact"' in app
    assert "成果物テストは未加工で再生します" in app
    assert "function resetPlayerToStart" in app
    assert "player.load();" in app
    assert "resetPlayerToStart(player);" in app
    assert "player.currentTime >= player.duration - 0.05" in app
    assert '<option value="all" selected>全部入り</option>' in index
    assert '<option value="clarity" selected>クリア優先</option>' not in index
    assert '$("speakerMaterialProfile")?.value || "all"' in app
    assert "SPEAKER_MATERIAL_PROFILES[id] || SPEAKER_MATERIAL_PROFILES.all" in app


def test_lab_engine_keeps_safetensors_symlink_path_for_checkpoint_loader():
    engine = read("lab_v3_engine_server.py")

    assert "return str(candidate.resolve())" not in engine
    assert "return str(env_checkpoint.resolve())" not in engine
    assert "return str(candidate)" in engine
    assert "return str(env_checkpoint)" in engine


def test_final_artifact_synthesis_bypasses_generic_irodori_repo_ready_check():
    bridge = read("irodori_openai_bridge.py")

    final_route = 'if ref_embed_path is not None and FINAL_ENGINE_ENDPOINT and config.get("runtime") == "final-engine":'
    local_route = 'if LOCAL_ENGINE_ENDPOINT and config.get("runtime") == "local-engine":'
    ready_check = 'state = ready_state()'
    assert final_route in bridge
    assert local_route in bridge
    assert ready_check in bridge
    synth_start = bridge.index("def synthesize(")
    ready_index = bridge.index(ready_check, synth_start)
    assert bridge.index(final_route, synth_start) < ready_index
    assert bridge.index(local_route, synth_start) < ready_index
    assert "probe_local_engine(FINAL_ENGINE_ENDPOINT, timeout=2.0)" in bridge
    assert "probe_local_engine(LOCAL_ENGINE_ENDPOINT, timeout=2.0)" in bridge
    assert "final engine endpoint is not configured. Start the bridge with Start Bridge Lab Only.command." in bridge
    assert "local engine endpoint is not configured. Start the bridge with Start Bridge Lab Only.command." in bridge


def test_standard_speaker_build_scales_steps_internally_but_hides_numbers_in_ui():
    index = read("index.html")
    app = read("app.js")

    assert "function recommendedSpeakerBuildSteps(sampleCount)" in app
    assert "Math.ceil((sampleCount * 16) / 100) * 100" in app
    assert "speakerBuildModeConfig({ sampleCount: items.length, generalCount })" in app
    assert '<option value="smoke">スモーク</option>' in index
    assert '<option value="standard" selected>標準</option>' in index
    assert '<option value="production">本番</option>' in index
    assert 'label: "標準"' in app
    assert 'label: "本番"' in app
    assert '標準 自動' not in app
    assert '標準 800step' not in index
    assert '本番 3000step' not in index


def test_cfg_defaults_are_one_for_voice_design_and_reference_generation():
    index = read("index.html")
    app = read("app.js")

    assert 'id="cfgText" class="control-input" type="number" value="1.0"' in index
    assert 'id="cfgCaption" class="control-input" type="number" value="1.0"' in index
    assert 'id="cfgSpeaker" class="control-input" type="number" value="1.0"' in index
    assert "DEFAULT_REFERENCE_CFG_SPEAKER = 1.0" in app
    assert "draft: { steps: 16, cfgText: 1.0, cfgCaption: 1.0, cfgSpeaker: DEFAULT_REFERENCE_CFG_SPEAKER }" in app
    assert "standard: { steps: 40, cfgText: 1.0, cfgCaption: 1.0, cfgSpeaker: DEFAULT_REFERENCE_CFG_SPEAKER }" in app
    assert "high: { steps: 64, cfgText: 1.0, cfgCaption: 1.0, cfgSpeaker: DEFAULT_REFERENCE_CFG_SPEAKER }" in app
    assert "function migrateLegacyCfgDefaults" in app
    assert "migrated.cfgText = 1.0" in app
    assert "migrated.cfgCaption = 1.0" in app
    assert "migrated.cfgSpeaker = 1.0" in app


def test_final_artifact_and_imported_reference_names_use_seed_take_name():
    app = read("app.js")

    assert "function voiceWorkBaseName" in app
    assert '$("seedTakeName")?.value' in app
    assert 'const baseName = voiceWorkBaseName(defaultName)' in app
    assert 'syncVoiceWorkNameFromReferenceFile(file);' in app
    assert 'function syncVoiceWorkNameFromReferenceFile' in app


def test_material_generation_clears_unconfirmed_reference_file():
    app = read("app.js")

    assert "function clearPendingMaterialReference" in app
    assert "clearPendingMaterialReference(settings);" in app
    assert app.count("clearPendingMaterialReference(settings);") >= 2


def test_seed_tab_can_export_saved_reference_wav():
    index = read("index.html")
    app = read("app.js")
    client = read("lib/tts-client.js")
    bridge = read("irodori_openai_bridge.py")

    assert 'id="downloadSelectedReference"' in index
    assert "保存済み参照wavを書き出し" in index
    assert 'id="deleteSelectedReferenceTop"' in index
    assert "保存済み参照wavを削除" in index
    assert "downloadReferenceVoice" in app
    assert "async function downloadSelectedReferenceVoice" in app
    assert "deleteSelectedReferenceTop" in app
    assert "function syncReferenceActionButtons" in app
    assert app.count("syncReferenceActionButtons();") >= 4
    assert "export async function downloadReferenceVoice" in client
    assert "/audio/voices/${safeId}/download" in client
    assert "export async function deleteReferenceVoice" in client
    assert 'path.startswith("/v1/audio/voices/") and path.endswith("/download")' in bridge
    assert 'self.send_file(reference_path, "audio/wav", f"{sanitize_id(voice_id)}.wav")' in bridge
    assert 'path.startswith("/v1/audio/voices/")' in bridge
    assert "delete_reference_voice(voice_id)" in bridge


def test_nanami_reference_and_final_samples_are_not_bundled_by_default():
    index = read("index.html")
    app = read("app.js")
    bridge = read("irodori_openai_bridge.py")
    readme = read("README.md")

    assert 'value="nanami"' not in index
    assert "Base Nanami" not in index
    assert "function ensureBaseNanamiReference" not in app
    assert "Base Nanami" not in app
    assert "INCLUDE_BUNDLED_REFERENCE_VOICES = False" in bridge
    assert "if INCLUDE_BUNDLED_REFERENCE_VOICES and voice_id in NANAMI_REFERENCE_IDS" in bridge
    assert "if INCLUDE_BUNDLED_REFERENCE_VOICES and BUNDLED_NANAMI_SAMPLE.is_file()" in bridge
    assert "assets/reference/nanami_voice_sample.wav" not in readme
    assert "assets/final/nanami-v1/checkpoint_final.speaker.safetensors" not in readme
    assert "初期サンプルとして" not in readme


def test_public_release_has_no_private_workspace_references():
    files = [
        "app.js",
        "index.html",
        "irodori_openai_bridge.py",
        "lab_v3_engine_server.py",
        "README.md",
        "MODEL_SETUP.md",
        ".env.example",
        "Setup Irodori.command",
        "Start Bridge Lab Only.command",
        "Start Bridge.command",
        "Start UI.command",
        "assets/final/sample-voice-01-01-mqxvg6zm/manifest.json",
        "assets/final/seed-voice-02-reference-mqx15gvj/manifest.json",
    ]
    combined = "\n".join(read(name) for name in files)
    forbidden = [
        "/" + "Users/" + "shige",
        "Application" + " Support",
        "SASAKO" + "dental_HP",
        "Dental" + " Aide",
        "Pix" + "ie",
        "dental" + "-note",
        "jp." + "sasako",
        "sasako" + "-voice-memo-app",
        "dental" + "-note-ai-desktop-research",
        "先生" + "のMac",
        "ご" + "主人様",
    ]

    for word in forbidden:
        assert word not in combined

    assert ".runtime/" in read(".gitignore")
    assert "assets/reference/*" in read(".gitignore")
    assert "assets/final/*" in read(".gitignore")
    assert "*.safetensors" in read(".gitignore")
    assert "*.gguf" in read(".gitignore")
    assert "third_party/" in read(".gitignore")
    assert ".env.local" in read(".gitignore")
    assert "!assets/final/sample-voice-01-01-mqxvg6zm/checkpoint_final.speaker.safetensors" in read(".gitignore")
    assert "!assets/final/seed-voice-02-reference-mqx15gvj/checkpoint_final.speaker.safetensors" in read(".gitignore")


def test_public_sample_final_artifacts_are_explicitly_bundled_and_sanitized():
    readme = read("README.md")
    gitignore = read(".gitignore")
    bridge = read("irodori_openai_bridge.py")
    app = read("app.js")
    samples = [
        "assets/final/sample-voice-01-01-mqxvg6zm/manifest.json",
        "assets/final/seed-voice-02-reference-mqx15gvj/manifest.json",
    ]

    assert "two small, reviewed public" in readme
    assert "assets/final/sample-voice-01-01-mqxvg6zm/" in readme
    assert "assets/final/seed-voice-02-reference-mqx15gvj/" in readme
    assert "!assets/final/sample-voice-01-01-mqxvg6zm/checkpoint_final.speaker.safetensors" in gitignore
    assert "!assets/final/seed-voice-02-reference-mqx15gvj/checkpoint_final.speaker.safetensors" in gitignore
    assert "for root in (GENERATED_FINAL_DIR, ASSET_FINAL_DIR):" in bridge
    assert "root == GENERATED_FINAL_DIR" in bridge
    assert 'const targetLabel = artifact.runtime ? ".runtime/final_artifacts" : "assets/final";' in app
    assert "if (deleteButton) deleteButton.disabled = Boolean(artifact.builtin);" in app

    for sample in samples:
        text = read(sample)
        assert "checkpoint_final.speaker.safetensors" in text
        assert "/Users/" not in text
        assert "Application" + " Support" not in text
        assert "Dental" + " Aide" not in text
        assert "Pix" + "ie" not in text


def test_beginner_setup_points_to_irodori_and_hugging_face_model_ids():
    readme = read("README.md")
    model_setup = read("MODEL_SETUP.md")
    env_example = read(".env.example")
    setup = read("Setup Irodori.command")
    bridge_start = read("Start Bridge Lab Only.command")

    assert "./Setup\\ Irodori.command" in readme
    assert "MODEL_SETUP.md" in readme
    assert "third_party/Irodori-TTS" in readme
    assert "git clone https://github.com/Aratako/Irodori-TTS.git third_party/Irodori-TTS" in setup
    assert "uv sync --extra cpu" in setup
    assert "cp .env.example .env.local" in setup
    assert "Aratako/Irodori-TTS-600M-v3-VoiceDesign" in env_example
    assert "Aratako/Irodori-TTS-500M-v3" in env_example
    assert "Aratako/Irodori-TTS-600M-v3-VoiceDesign" in model_setup
    assert "Aratako/Irodori-TTS-500M-v3" in model_setup
    assert "source \"$ENV_FILE\"" in bridge_start
    assert "LAB_VOICE_MODEL=\"${IRODORI_LAB_VOICE_MODEL:-Aratako/Irodori-TTS-600M-v3-VoiceDesign}\"" in bridge_start
    assert "FINAL_BASE_CHECKPOINT=\"${IRODORI_FINAL_BASE_CHECKPOINT:-Aratako/Irodori-TTS-500M-v3}\"" in bridge_start
    assert "FINAL_ENGINE_CONFIG_AUTO=1" in bridge_start
    assert "IRODORI_LAB_ENGINE_START_TIMEOUT=\"${IRODORI_LAB_ENGINE_START_TIMEOUT:-600}\"" in bridge_start
    assert "IRODORI_FINAL_ENGINE_START_TIMEOUT=\"${IRODORI_FINAL_ENGINE_START_TIMEOUT:-300}\"" in bridge_start
    assert "First model download can be slow." in bridge_start


def test_final_artifact_cards_can_be_hidden_or_deleted_with_clear_export_wording():
    index = read("index.html")
    app = read("app.js")
    client = read("lib/tts-client.js")
    bridge = read("irodori_openai_bridge.py")
    styles = read("styles.css")

    assert "INCLUDE_BUNDLED_FINAL_ARTIFACTS = False" in bridge
    assert "if INCLUDE_BUNDLED_FINAL_ARTIFACTS and bundled_ok" in bridge
    assert "safetensorsを書き出し" in index
    assert "safetensorsを保存" not in index
    assert 'id="hideFinalArtifactCard"' in index
    assert 'id="deleteFinalArtifactFiles"' in index
    assert "FINAL_ARTIFACT_HIDDEN_KEY" in app
    assert "function hiddenFinalArtifactIds" in app
    assert "function hideActiveFinalArtifactCard" in app
    assert "async function deleteActiveFinalArtifactFiles" in app
    assert "deleteFinalArtifact(" in app
    assert "targetLabel = artifact.runtime" in app
    assert "artifacts.filter((artifact) => !hidden.has(artifact.artifact_id))" in app
    assert "finalArtifacts.some((artifact) => artifact.artifact_id === activeFinalArtifactId)" in app
    assert 'activeFinalArtifactId = finalArtifacts[0]?.artifact_id || "";' in app
    assert "export async function deleteFinalArtifact" in client
    assert 'method: "DELETE"' in client
    assert "def delete_final_artifact" in bridge
    assert 'path.startswith("/v1/lab/final-artifacts/")' in bridge
    assert 'self.send_json(delete_final_artifact(artifact_id))' in bridge
    assert ".final-test-actions .button" in styles
    assert "overflow-wrap: anywhere" in styles


def test_final_test_tab_uses_playground_layout_and_card_editing():
    index = read("index.html")
    app = read("app.js")
    styles = read("styles.css")

    assert 'id="resetTextGeneration"' not in index
    assert 'id="generate" class="button primary-action"' not in index
    assert "テキスト生成を標準へ" not in index
    assert "新規カード化" not in index
    assert 'class="final-test-playground"' in index
    assert 'id="finalArtifactActiveCard"' not in index
    assert 'id="finalArtifactEditPanel"' in index
    assert "renderFinalArtifactActive" not in app
    assert ".final-artifact-active-card" not in styles
    assert "カードメモ編集" in index
    assert "data-final-artifact-edit-id" in app
    assert "function beginFinalArtifactCardEdit" in app
    assert "function cancelFinalArtifactCardEdit" in app
    assert "function finalArtifactDescriptionDraft" in app
    assert "saveFinalArtifactDescription" in app
    assert "renderFinalArtifacts();" in app
    assert "左の完成カードの編集ボタン" in app
    assert "finalArtifactDescription\" class=\"control-input final-description-area\"" in index
    assert ".final-artifact-grid" in styles
    assert "max-height: min(560px, calc(100vh - 260px))" in styles
    assert "overflow-y: auto" in styles
    assert ".final-test-playground" in styles


def test_removed_seed_generate_button_does_not_break_generation_handlers():
    index = read("index.html")
    app = read("app.js")

    assert 'id="generate"' not in index
    assert "setOptionalDisabled" in app
    assert '$("generate").disabled' not in app
    assert '$("generateTop").disabled' not in app
    assert 'setOptionalDisabled("generate", true);' in app
    assert 'setOptionalDisabled("generate", false);' in app
    assert 'setOptionalDisabled("generateTop", true);' in app
    assert 'setOptionalDisabled("generateTop", false);' in app
    assert "20260629-generate-fix1" in index


def test_file_protocol_mode_warns_and_preserves_seed_layout():
    index = read("index.html")
    styles = read("styles.css")

    assert '<body data-active-lab-tab="seed">' in index
    assert "location.protocol !== \"file:\"" in index
    assert "file-protocol-banner" in index
    assert "HTTPで開いてください" in index
    assert "Start UI.command" in index
    assert "setFallbackLabTab" in index
    assert "document.querySelectorAll(\"[data-lab-tab-target]\")" in index
    assert ".file-protocol-banner" in styles
    assert "body[data-active-lab-tab=\"seed\"] .seed-source-row" in styles
    assert "body[data-active-lab-tab=\"seed\"] .seed-settings-grid" in styles
    assert "body[data-active-lab-tab=\"seed\"] .seed-result-grid" in styles
    assert "grid-template-columns: 1fr;" in styles


def test_expression_header_uses_compact_layout():
    index = read("index.html")
    styles = read("styles.css")
    app = read("app.js")

    assert "<strong>表現音候補</strong>" in index
    assert "まず生成候補を作ります" in index
    assert "必要なら自作表現を先に作ってから、12本・50本・145本を後ろに追加できます" in index
    assert "grid-template-columns: minmax(190px, 0.32fr) minmax(280px, 1fr)" in styles
    assert "grid-column: 1 / -1" in styles
    assert "max-width: 720px" in styles
    assert "font-size: clamp(18px, 1.7vw, 26px)" in styles
    assert "line-height: 1.08" in styles
    assert "function appendExpressionQueueItems" in app
    assert "expressionQueue.push(...newItems)" in app
    assert "const startOrder = expressionQueue.length" in app
    assert "候補を追加しました" in app


def test_expression_generation_can_use_direct_voice_design_without_reference_audio():
    index = read("index.html")
    app = read("app.js")

    assert 'id="expressionSourceMode"' in index
    assert '<option value="direct" selected>VoiceDesign直接</option>' in index
    assert '<option value="reference">参照音声を使う</option>' in index
    assert "function expressionSourceMode" in app
    assert "DEFAULT_EXPRESSION_SOURCE_MODE = \"direct\"" in app
    assert "let expressionSeedBase = \"\"" in app
    assert "function ensureExpressionSeedBase" in app
    assert 'voice: sourceMode === "direct" ? "none" : settings.voice' in app
    assert "item.seed || expressionSeedForItem" in app
    assert "VoiceDesign直接" in app
    assert "参照音声を使わず、声の説明と固定Seedから直接表現音を生成します" in app


if __name__ == "__main__":
    test_generation_payload_uses_45_second_max_duration()
    test_expression_sets_are_gendered_and_include_power_shout()
    test_custom_expression_generation_controls_exist()
    test_general_speech_set_can_be_added_to_final_artifact()
    test_general_speech_batch_retries_and_continues_after_transient_fetch_errors()
    test_speaker_build_polling_recovers_from_temporary_fetch_errors()
    test_final_artifact_test_uses_stable_ref_embed_settings_without_live_eq()
    test_lab_engine_keeps_safetensors_symlink_path_for_checkpoint_loader()
    test_final_artifact_synthesis_bypasses_generic_irodori_repo_ready_check()
    test_standard_speaker_build_scales_steps_internally_but_hides_numbers_in_ui()
    test_cfg_defaults_are_one_for_voice_design_and_reference_generation()
    test_final_artifact_and_imported_reference_names_use_seed_take_name()
    test_material_generation_clears_unconfirmed_reference_file()
    test_seed_tab_can_export_saved_reference_wav()
    test_nanami_reference_and_final_samples_are_not_bundled_by_default()
    test_public_release_has_no_private_workspace_references()
    test_public_sample_final_artifacts_are_explicitly_bundled_and_sanitized()
    test_beginner_setup_points_to_irodori_and_hugging_face_model_ids()
    test_final_artifact_cards_can_be_hidden_or_deleted_with_clear_export_wording()
    test_final_test_tab_uses_playground_layout_and_card_editing()
    test_removed_seed_generate_button_does_not_break_generation_handlers()
    test_file_protocol_mode_warns_and_preserves_seed_layout()
    test_expression_header_uses_compact_layout()
    test_expression_generation_can_use_direct_voice_design_without_reference_audio()
    print("voice labo static tests passed")
