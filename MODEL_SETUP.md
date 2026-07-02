# モデル準備

NANAMI VOICE LABO には、Irodori-TTS のモデル本体は含まれていません。

基本的には、次の流れで自動準備されます。

1. `./Setup Irodori.command` を実行する
2. `./Start UI.command` を実行する
3. `./Start Bridge Lab Only.command` を実行する
4. 短いテスト音声を生成する

初回生成時に、bridge が Hugging Face から次のモデルを取得します。

- `Aratako/Irodori-TTS-600M-v3-VoiceDesign`
- `Aratako/Irodori-TTS-500M-v3`

ダウンロードには数分かかることがあります。
`Start Bridge Lab Only.command` は、初回の VoiceDesign 起動を標準で最大10分待ちます。
一度取得すれば、モデルはローカルにキャッシュされます。

## Irodori-TTS の場所

セットアップコマンドは、Irodori-TTS を次に取得します。

```text
third_party/Irodori-TTS
```

このディレクトリは Git 管理外です。

## 手動でモデルを指定する場合

すでに `model.safetensors` を手元に持っている場合は、
`.env.example` を `.env.local` にコピーして、次を編集します。

```bash
IRODORI_LAB_VOICE_MODEL=/absolute/path/to/Irodori-TTS-600M-v3-VoiceDesign/model.safetensors
IRODORI_FINAL_BASE_CHECKPOINT=/absolute/path/to/Irodori-TTS-500M-v3/model.safetensors
IRODORI_SPEAKER_BASE_CHECKPOINT=/absolute/path/to/Irodori-TTS-500M-v3/model.safetensors
```

通常はこの手動設定は不要です。

## Speaker Inversion 用Python

Speaker Inversion では、Irodori-TTS の `prepare_manifest.py` と `train.py` を使います。
ジョブ開始前に、bridge は選択されたPythonで次をimportできるか確認します。

- `torch`
- `pandas`
- `datasets`
- Irodori codec

もしこの確認で失敗したり、import中に止まる場合は、`.env.local` に動作確認済みの
Python環境を指定してください。

```bash
IRODORI_SPEAKER_PYTHON=/absolute/path/to/python3.10
IRODORI_SPEAKER_PYTHONPATH=/absolute/path/to/Irodori-TTS/.venv/lib/python3.10/site-packages
IRODORI_SPEAKER_HF_HOME=/absolute/path/to/hf_home
```

この設定は Speaker Inversion だけに効きます。
テキストから音声を作る通常生成は、通常のラボエンジンを使い続けられます。
