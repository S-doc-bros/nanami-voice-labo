# NANAMI VOICE LABO

NANAMI VOICE LABO は、Irodori-TTS / Irodori-TTS-Lite を使って声を作り、
表現音を集め、Speaker Inversion の成果物を試せるローカル音声ラボです。

日本語での利用を前提に、まず「起動できること」「音声を作れること」
「作った素材を最終成果物として試せること」を優先しています。

このリポジトリはソースコード中心です。公開用に確認済みの小さなサンプル成果物を
2つだけ同梱していますが、参照音声、生成した wav、モデル本体、ローカルキャッシュ、
実行ログ、作業中の成果物は含めません。

## できること

- 声の説明文と読み上げテキストから seed wav を作る
- 手元の参照 wav を読み込み、生成結果を比較する
- 笑い、息づかい、むせ、飲み込み、口腔音、絶叫、泣き、強い叫びなどの表現音候補を作る
- 生成した候補を耳で確認して、採用、音だけ採用、保留、録音、ボツに分ける
- 採用した wav とメタデータを書き出す
- ローカルで Speaker Inversion を実行し、`checkpoint_final.speaker.safetensors` を作る
- 完成した成果物を `成果物テスト` タブで試す

## 含まれていないもの

公開リポジトリには、次のものを入れない方針です。

- 参照音声 wav
- 生成した wav
- 追加の `checkpoint_final.speaker.safetensors`
- Irodori のモデル本体
- GGUF scriptwriter モデル
- `.runtime/` 以下のログ、キャッシュ、ジョブ出力、作業データ

声素材やモデルは、それぞれのライセンスと利用条件を確認して、自分で用意してください。

## 動作環境

- 推奨: macOS / Apple Silicon
- Python 3.10 以上
- 音声変換用の `ffmpeg`
- 依存管理用の `uv`
- Irodori-TTS のチェックアウト

Windows / Linux でも原理的には動く可能性がありますが、現時点では未検証です。

## 初回起動

macOS / Apple Silicon での基本の流れです。

1. 足りないコマンドラインツールを入れる
2. セットアップを1回実行する
3. UIを起動する
4. bridgeを起動する
5. ブラウザでローカルURLを開く

`git` が無いと言われたら、Apple のコマンドラインツールを入れます。

```bash
xcode-select --install
```

`uv` や `ffmpeg` が無いと言われたら、Homebrew で入れます。

```bash
brew install uv ffmpeg
```

次に、セットアップを1回だけ実行します。

```bash
cd /path/to/nanami-voice-labo
./Setup\ Irodori.command
```

UIを起動します。

```bash
./Start\ UI.command
```

ブラウザで開きます。

```text
http://localhost:5190
```

別のTerminalで、ローカルbridgeを起動します。

```bash
./Start\ Bridge\ Lab\ Only.command
```

初回は Hugging Face から Irodori のモデルを取得するため、数分かかることがあります。

- `Aratako/Irodori-TTS-600M-v3-VoiceDesign`
- `Aratako/Irodori-TTS-500M-v3`

`Start Bridge Lab Only.command` は、初回の VoiceDesign エンジン起動を最大10分待ちます。
一度モデルが入れば、次回以降の起動はかなり速くなります。

手動で取得した `model.safetensors` を使いたい場合は [MODEL_SETUP.md](MODEL_SETUP.md) を見てください。

## 普段の起動

UI:

```bash
cd /path/to/nanami-voice-labo
./Start\ UI.command
```

開くURL:

```text
http://localhost:5190
```

bridge:

```bash
cd /path/to/nanami-voice-labo
./Start\ Bridge\ Lab\ Only.command
```

UI内のAPI URLは通常このままで使えます。

```text
http://localhost:8088/v1
```

## 主な使い方

1. `テキストから生成` で、声の説明文とテキストから seed wav を作る
2. `表現音セット` で、表現音候補を作る
3. `人間チェック` で、耳で聞いて採用する候補を選ぶ
4. `調整から成果物` で、Speaker Inversion の成果物を作る
5. `成果物テスト` で、完成した声を試す

最初は12本や50本の少ない候補で試して、うまくいく声だと確認してから本番数に増やすと扱いやすいです。

## 保存場所

実行中のデータは次に保存されます。

```text
.runtime/
```

ここには、生成音声、ログ、Speaker Inversion のジョブ、Hugging Face キャッシュ、
ローカルで作った最終成果物などが入ります。

`.runtime/` は Git 管理外です。公開したいものだけを自分で明示的に書き出してください。

ローカルで作った最終成果物は次に保存されます。

```text
.runtime/final_artifacts/
```

公開リポジトリに同梱している確認済みサンプル成果物は、この2つだけです。

```text
assets/final/sample-voice-01-01-mqxvg6zm/
assets/final/seed-voice-02-reference-mqx15gvj/
```

他の成果物をGitへ追加する場合は、素材の利用条件、内容、ローカルパスの混入、由来を確認してください。

## よく使う環境変数

必要な場合だけ `.env.example` を `.env.local` にコピーして編集します。

- `IRODORI_REPO_DIR`: Irodori-TTS の場所
- `NANAMI_VOICE_ENGINE_HOME`: モデル、設定、Hugging Face キャッシュを置く場所
- `IRODORI_LAB_VOICE_MODEL`: VoiceDesign 用チェックポイント、または Hugging Face モデルID
- `IRODORI_FINAL_BASE_CHECKPOINT`: 成果物テスト用のベースチェックポイント、または Hugging Face モデルID
- `IRODORI_FINAL_ENGINE_CONFIG`: 成果物テスト用の設定JSON。通常は空でOK
- `IRODORI_PYTHON`: Irodori / Speaker Inversion に使うPython
- `IRODORI_SPEAKER_PYTHON`: Speaker Inversion の `prepare_manifest.py` / `train.py` だけに使うPython
- `IRODORI_SPEAKER_PYTHONPATH`: Speaker Inversion 用の site-packages
- `IRODORI_SPEAKER_BASE_CHECKPOINT`: Speaker Inversion のベースチェックポイント
- `IRODORI_SPEAKER_HF_HOME`: Speaker Inversion 用の Hugging Face キャッシュ
- `IRODORI_SCRIPTWRITER_ENDPOINT`: 任意のOpenAI互換scriptwriter endpoint
- `IRODORI_SCRIPTWRITER_AUTOSTART=0`: ローカルscriptwriterの自動起動を止める
- `IRODORI_LAB_ENGINE_START_TIMEOUT`: VoiceDesign エンジンの起動待ち秒数。初期値は `600`
- `IRODORI_FINAL_ENGINE_START_TIMEOUT`: 成果物テスト用エンジンの起動待ち秒数。初期値は `300`

## Speaker Inversion の確認

最終成果物を作る前に、bridge は Speaker Inversion 用Pythonで次をimportできるか確認します。

- `torch`
- `pandas`
- `datasets`
- Irodori codec

画面やhealthに `speaker prepare dependency check failed` と出る場合は、
Speaker Inversion に使うPython環境が足りていません。

その場合は `.env.local` に次のように設定します。

```bash
IRODORI_SPEAKER_PYTHON=/absolute/path/to/python3.10
IRODORI_SPEAKER_PYTHONPATH=/absolute/path/to/Irodori-TTS/.venv/lib/python3.10/site-packages
IRODORI_SPEAKER_HF_HOME=/absolute/path/to/hf_home
```

これは最終成果物作成だけに効きます。テキストから音声を作る通常生成とは分けて扱えます。

## Irodori-TTS について

NANAMI VOICE LABO は Irodori-TTS 本体ではありません。
音声生成ランタイムとして Irodori-TTS を利用します。

セットアップでは、Irodori-TTS を次に取得します。

```text
third_party/Irodori-TTS
```

このディレクトリは Git 管理外です。再配布時は、Irodori-TTS とそのライセンス表記を分けて扱ってください。

## 公開前チェック

公開やリリース前には、少なくとも次を確認してください。

- `.runtime/` が含まれていない
- `assets/reference/` に参照 wav が入っていない
- `assets/final/` には確認済みサンプルだけが入っている
- ローカル絶対パス、APIキー、トークン、生成モデルファイルをステージしていない

このリポジトリの `.gitignore` は、音声、モデル、ログ、キャッシュ、書き出し物を広めに除外しています。

## License

NANAMI VOICE LABO のソースコードは MIT License です。詳細は [LICENSE](LICENSE) を見てください。

このライセンスは、このリポジトリ内のNANAMI VOICE LABOのソースコードと、
意図して同梱した確認済みサンプルファイルに適用されます。
Irodori-TTS、Irodoriのモデル、サードパーティ依存、利用者が用意した声素材、
生成データセット、利用者が作成したspeaker artifactには適用されません。

依存関係、モデル、音声素材に関する注意は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を見てください。

## English Short Note

NANAMI VOICE LABO is a local voice lab for Irodori-TTS / Irodori-TTS-Lite.
It helps create seed wav files, expression datasets, Speaker Inversion artifacts,
and final voice tests. The repository is source-first and does not include model
weights, generated wav files, runtime caches, or private reference voices.
