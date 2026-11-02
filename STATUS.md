# STATUS

最終更新: 2026-11-02(描画をまたいでレンダラ・デコード済みタイル・線と塗りのバケットを再利用。フェーズ2・3・4・6 完了。クラスタ・DEM・WASM最適化を現構成へ統合。PNG出力・Workersロード対応を追加。都会・高ズームの重複処理、フィルタ前の座標変換・グリフ依存探索・GeoJSONタイル生成の重複を削減。三角形走査を行単位の被覆区間に限定。DEMタイルの縁埋め・陰影の傾斜計算をソース内のレイヤ間で共有。libmの`round`呼び出しを除去し、合成とバイリニア補間を明示的なSIMDに。フェーズ5の人間レビューを経ずに、指示によりフェーズ6(symbol)を先行実施)

## スコープ決定(2026-10-31、人間判断)

- geojson / image ソースは対象。
- 実行時のスタイル・カメラ変更は対象外。`metadata.test.operations` に wait/idle/sleep/redraw 以外を含むテストは skip。
- API の最小形は「style.json + XYZ → タイル画像」(`View::tile`)。任意カメラは `View` で指定。
- 現在の対応投影は mercator。将来は他のprojectionも対応する予定のため、新たな高速化でメルカトル固有の仮定を増やさず、投影後の画面形状から適用可否を判断する（2026-11-01指示）。

## 通過率

Expression: **581 / 583(99.7%)**

Render: **pass 988 / fail 20 / skip 727**(in scope 1008 中 98.0%)。マスクの省メモリ化後に全1735件を再実行。変更前と全件の判定・差分率が一致。

| layer type | pass | fail | skip | 通過率 |
|---|---|---|---|---|
| background | 406 | 7 | 357 | 98.3% |
| circle | 156 | 1 | 128 | 99.4% |
| fill | 131 | 2 | 90 | 98.5% |
| line | 206 | 2 | 80 | 99.0% |
| raster | 87 | 0 | 77 | 100.0% |
| symbol | 425 | 20 | 241 | 95.5% |
| hillshade | 49 | 0 | 12 | 100.0% |
| color-relief | 15 | 0 | 0 | 100.0% |
| heatmap | 38 | 0 | 6 | 100.0% |

(1テストは使用する全レイヤ種別に計上。fail 20 はすべて symbol レイヤを含むテスト。内訳は「未対応・既知の問題」)

## 実装済み

### 描画をまたいだバケット再利用・layoutグループ共有 (2026-11-02)

- 調査: demo スタイル(demotiles)の 256px / DPR 2 / margin 64 タイルでは、1枚あたり z2 で約36 ms(native)。内訳は線の三角形ラスタライズ約3割、線のテッセレーション約27%、earcut 約12%、MVT デコード 2%未満。描画ごとに `Renderer` を作り直していたため、隣り合う出力タイルが同じソースタイルを毎回デコード・テッセレーションしていた。画面外の地物を bbox で先に除く試作は 35.9→34.4 ms と効果が小さく不採用(国境・海岸線の地物が大きい)。
- `Renderer::set_view(view)` を追加。カメラだけ切り替え、取得済みリソースと派生データを保持する。pixel ratio が変わると sprite を取り直す。`provide` は今のビューではなく `needs()` が返した URL の記録(`requested`)と照合するので、`needs` と `provide` の間に別ビューへ切り替わっても取りこぼさない(JS では 1 つのレンダラを複数の描画が `await` をまたいで共有する)。グリフ範囲の URL 記録も上書きせず蓄積する。
- タイル単位のバケットキャッシュ: `TileFeatures::bucket` が (データタイル, canonical, overscaled zoom) ごとの領域に、線の `LineBucket`(`addLine` の結果と gradient 用 clip)と塗りの `FillBucket`(earcut 済みポリゴン)を保持する。中身はタイル・ソースデータ・layout だけに依存し、カメラや paint には依存しない。
- 追い出し: ソースごとにデータタイル(GeoJSON は canonical タイル)の最終使用時刻を持ち、`render` の開始時に現在のビュー以外の古いものから `MAX_CACHED_TILES`(8)まで削る。デコード済みタイル・overzoom の切り出し・バケットも一緒に消える。上限 32 では demo で 233 MiB に達したため 8 にした(32 と比べて速度差は約4%)。
- layout グループ: type・source・source-layer・filter・layout と `needs_geometry` が同じレイヤは同じバケットを共有する(MapLibre の `groupByLayout` 相当。バケットの中身に影響しない zoom 範囲は除外)。道路の縁取りと本体のような組で、1回だけの描画でもテッセレーションが一度で済む。
- バケットの省メモリ化: `Vertex` の extrude / offset normal を量子化済みの i8 で、uv_x を f32(シェーダが f32 で読むため同値)、split を u32 で持つ。三角形のインデックスは u32。構築後に余剰容量を解放し、地物の座標配列を手放す。join 種別の判定で頂点ごとに `String` を確保していたのも除去。
- TS: `MapRenderer` は WASM レンダラを 1 つ保持し、各描画は `needs`/`render` の直前に `renderer_set_view` を呼ぶ。生成から `cache.ttlMs` 経過したレンダラは引退させ、使用中の描画が終わってから解放する(`ttlMs: 0` なら従来どおり描画ごとに作り直す)。取得したバイト列の LRU キャッシュ(`cache.maxBytes`、既定 64 MiB)は削除した。キャッシュはホストの責務とし(ブラウザの HTTP キャッシュ、または `loadResource` 内)、同じ URL の同時取得を 1 回にまとめる処理だけ残す(z2 の 16 枚を並行描画して各 URL 1 回、出力は逐次描画と一致)。`cache.ttlMs` は WASM レンダラの再利用期間の意味だけになった。`scripts/bench.ts` はサンプルごとにレンダラを作り直し、従来どおりキャッシュなしの 1 回の描画を測る。
- デモ: `TileWorker` が Worker を `min(4, コア数−1)` 本持ち、未完了の描画が最も少ない Worker に割り振る。
- 計測(Node 24 / SIMD WASM、demo スタイル、取得済み素材、新しいレンダラで各ズームの全タイルを 1 巡、5回の中央値):

| ケース | 変更前 | 変更後 | 時間削減 |
|---|---:|---:|---:|
| z2 (16枚) | 39.5 ms/枚 | 24.8 ms/枚 | 37% |
| z3 (64枚) | 28.5 ms/枚 | 18.6 ms/枚 | 35% |
| z4 (256枚) | 18.0 ms/枚 | 13.9 ms/枚 | 23% |

- WASM メモリ(上記を z2→z4 と続けた最大値): 24 MiB → 74 MiB。`pnpm bench`(キャッシュなしの 1 回の描画)は bright z14 -13.8%、bright z15 / basic z15 / GeoJSON lines -7〜9%(layout グループ共有による)、その他は誤差内、WASM 1,934 KB(+1.2%)。
- 全ケースで RGBA が変更前と一致。描画テスト 1735 件は判定・差分率が全件一致(pass 988 / fail 20 / skip 727)。単体テスト 37 件成功。追加した `reused_renderer_matches_fresh_renders` は、z3 全タイル→z4(overzoom)→z3 再訪→DPR 変更の各ビューで、使い回したレンダラと新しいレンダラの出力一致と、キャッシュ上限を検査する(追い出し漏れ・キーから overscaled zoom を外す・`set_view` でカメラが動かない、の 3 種の誤りで失敗することを確認)。
- 既知の制約: 上限はタイル数で、バイト数ではない。密な低ズームのタイルは 1 枚で数 MiB のバケットを持つ。Cloudflare Workers(128 MB)など厳しい環境では `ttlMs: 0` で無効化できる。demo スタイルの coastline と countries-boundary は filter が `["all"]` と未指定で異なるため、グループにならない。symbol のバケットは再利用していない(配置はビューに依存するが、レイアウトは将来再利用できる)。

### round の内製化と明示的 SIMD (2026-11-02)

- 調査: `+simd128` の自動ベクトル化だけでは SIMD 有無の差が 0〜6%（東京z14のみ6%、他は約1%）、SIMD 命令を含むコードも約4 KBしかなかった。名前付き WASM の CPU プロファイルでは、東京z14の約9%、DEMの約5%が libm の `round` / `roundf` 呼び出しだった。WASMには「0.5は0から遠い側へ」丸める命令がなく（`f32.nearest` は偶数丸め）、`f32::round` が関数呼び出しになって4チャンネルの演算のベクトル化も妨げていた。
- `Target::blend`: `trunc`（WASMのネイティブ命令）から作った `raster::round` を使う。`f32::round` とビット単位で同じ結果（[-256, 256] の全f32と非有限値で確認済み。単体テストは境界付近と間引いた範囲を検査）。
- `Texture::new` の事前乗算: `round(c·a/255)` を f64 から整数式 `(c·a + 127) / 255` に置き換えた。c·a/255 は .5 ちょうどにならないので同値（256×256 の全組を単体テストで確認）。
- 明示的な f32x4: `Target::blend` と `Texture::sample` のバイリニア補間を `core::arch::wasm32` で4チャンネル同時に計算する。演算の種類と順序はスカラー版と同じで、近似していない（NaNは0、-0は0になる点も同じ）。`wasm32` かつ `simd128` のときだけ使い、ネイティブ（テストランナー）や SIMD なしのビルドはスカラー版のまま。
- 計測（Node 26 / ストリップ済みの本番WASM、前回項目の完了時点と比較、7回の中央値）:

| ケース | 変更前 | 変更後 | 時間削減 |
|---|---:|---:|---:|
| 東京 z14 | 264.9 ms | 211.4 ms | 20.2% |
| 東京 z16 | 163.9 ms | 117.4 ms | 28.4% |
| 東京 z18 | 97.9 ms | 58.7 ms | 40.1% |
| 東京 z16 / bearing 17° | 118.0 ms | 82.4 ms | 30.2% |
| GeoJSON: 1500本×24頂点、8レイヤ | 16.1 ms | 15.7 ms | 2.7%（小差） |
| GeoJSON: 1万点のラベル | 51.8 ms | 49.7 ms | 4.1% |
| GeoJSON: 長い斜め線80本 | 7.4 ms | 5.7 ms | 22.4% |
| 1024アイコン | 54.1 ms | 23.8 ms | 56.0% |
| DEM: hillshade | 71.7 ms | 49.8 ms | 30.5% |
| DEM: color-relief + hillshade | 103.9 ms | 68.6 ms | 34.0% |
| DEM: color-relief + hillshade 2レイヤ | 137.0 ms | 86.9 ms | 36.5% |

- 内訳（段階ごとの比較）: `round` の置き換えが東京で12〜29%、アイコンで50%（SIMDの有無では差なし）。明示的 SIMD の合成がさらに7〜21%。バイリニア補間の SIMD は DEM で11〜16%、その他はノイズの範囲。
- 全ケース・全試行で RGBA の SHA-256 が変更前と一致し、bearing 17° / DPR 1.5 / margin 0 の RGBA と PNG も一致。ネイティブの描画テスト1735件は判定・差分率が全件一致（pass 988 / fail 20 / skip 727）。SIMD 版の WASM 上での一致はこのベンチマークでのみ確認しており、上流描画テストを WASM で実行してはいない。Rust単体テスト37件成功。WASM 1,911,482 bytes。
- 残りのプロファイル: 東京は確保・解放、`Value` の clone/drop、SipHash、式評価、`draw_line` / `draw_fill` のシェーダ部分が中心で、SIMD の対象ではない。DEM は `atan` / `cos` / `atan2` などの libm（ビット一致が必要なので近似に置き換えていない）と `draw_dem_layer` の画素ループ。
- 計測・プロファイル用スクリプトと各段階の WASM: `target/benchmark/simd/`（生成物、gitignore、`reproduce.txt` に手順）。

### DEMレイヤ間の重複計算を削減 (2026-11-02)

- 縁を埋めたDEMタイルを描画ごとの `render::Ctx` にソースID単位で保持し、同じソースの hillshade / color-relief レイヤで共有する。従来はレイヤごとにDEMのコピー、隣接タイルからの縁埋め、陰影の傾斜テクスチャ生成（`hillshadePrepare`）をやり直していた。傾斜テクスチャは最初に使うときに作る（MapLibreの `needsHillshadePrepare` 相当）。1回の描画内ではソースの描画タイル集合が変わらないため、キーはソースIDだけで足りる。
- `prepare` は各画素の標高を1回だけ求める（従来は周囲9点の計算ごとに再計算）。陰影シェーダの光源ごとの高度角・方位角のcos/sinと、standard方式の `base^(π/2) - 1` をレイヤ単位で事前計算する。f32の演算式と順序は変えていない。
- 計測: 上流fixtureのDEM（`12-758..759-1608..1609.terrain.png`、256px、mapbox）。z13・512×512 CSS px / DPR 2、Node 26 / SIMD WASM、ウォームアップ2回後の7回の中央値。前後を交互に実行し、画像ごとのレンダラ生成・デコード・描画・破棄を含む。

| ケース | 変更前 | 変更後 | 時間削減 |
|---|---:|---:|---:|
| hillshade 1レイヤ | 76.5 ms | 71.8 ms | 6.1% |
| color-relief + hillshade（同一ソース） | 109.3 ms | 103.5 ms | 5.3% |
| color-relief + hillshade 2レイヤ（同一ソース） | 168.3 ms | 137.7 ms | 18.2% |

- 全ケースでbearing 0° / 17°のRGBAのSHA-256が変更前と一致。描画テスト1735件は判定・差分率が全件一致（pass 988 / fail 20 / skip 727）。同一ソースを共有する上流テスト（`color-relief/hillshade`、`combinations/hillshade-translucent--hillshade-translucent`）も差分0のまま。Rust単体テスト36件成功。WASMを再ビルド済み、1,909,260 bytes。
- 残りの時間の大半は画素ごとのシェーダ計算（atan / pow / sin / cos と緯度補正のcos）。出力をビット一致させる必要があるため手を入れていない。計測スクリプトと前後のWASM: `target/benchmark/dem-reuse/`（生成物、gitignore）。

### 投影法に依存しない矩形マスクの省メモリ化 (2026-11-01)

- カメラ回転係数の再利用、マスクの簡略化、文字・アイコンの矩形直接描画を個別に試作・計測した。カメラ回転係数の再利用は東京で0〜2%程度の小差にとどまり、斜め線のケースで約9%遅くなったため不採用。矩形直接描画もアイコンの描画部分は13.3→11.8 msになったが、画像生成全体では約1%の改善で東京z14は悪化したため不採用。
- 採用したのはマスクの簡略化のみ。実際に渡された画面座標の四角形が軸に沿う矩形か検査し、その場合は画面サイズの画素配列を作らずx/yの被覆範囲で保持する。回転・変形した四角形は従来の一般的な画素マスクを使う。親から子の範囲を除く場合も画素表現に変換でき、穴や複数の被覆区間を維持する。格納方式と差分処理は `Mask` 内に隠した。
- 判定に地理座標・緯度・タイルズーム・bearing 0の条件は使っていない。`from_quad` は投影後の直線辺からなる四角形を受け取る契約。将来、投影によって境界が曲がる場合の投影・メッシュ化はその前段で行う。地理投影が画面全体でアフィンになる、局所方向が一定になる、といった仮定は追加していない。非メルカトル投影の実装自体は今回追加していない。
- 基準は前項までの最適化を含む `047cbd2` のWASM。Node 26.13.0 / SIMD WASM、取得済み素材、ウォームアップ2回後の7回の中央値。画像ごとのレンダラ生成・素材デコード・描画・破棄を含み、ネットワーク・WASM初期化・PNG圧縮を除いて前後を交互に比較した。

| ケース | 今回の変更前 | 変更後 | 時間削減 | WASM確保メモリの前→後 |
|---|---:|---:|---:|---:|
| 東京 z14 | 235.49 ms | 233.96 ms | 0.7%（小差） | 151.69→150.50 MiB |
| 東京 z16 | 151.06 ms | 150.49 ms | 0.4%（小差） | 134.19→132.13 MiB |
| 東京 z18 | 91.58 ms | 91.61 ms | ほぼ変化なし | 80.94→79.69 MiB |
| 東京 z16 / bearing 17° | 108.25 ms | 108.78 ms | ほぼ変化なし | 122.06→122.06 MiB |
| GeoJSON: 1500本×24頂点、8レイヤ | 15.19 ms | 14.08 ms | 7.3% | 33.81→29.44 MiB |
| GeoJSON: 長い斜め線80本 | 7.94 ms | 6.82 ms | 14.2% | 10.19→7.50 MiB |

- 1万点ラベル（bearing 0° / 37°）は約0.3〜0.4%の小差で、確保メモリは変化なし。1024アイコンは描画部分13.04→13.04 msで変化せず、画像生成全体ではデコード時間の差を含め50.87→51.91 ms。独立した初回比較でも複数レイヤのGeoJSONは11.6%、斜め線は13.2%短縮した（`baseline-final-first.json`）。全9ケースで全計測試行のRGBAのSHA-256が一致し、PNGバイトも一致。各ケースをbearing 17° / DPR 1.5 / margin 0でも比較しRGBA・PNGが一致。ブラウザや非メルカトル投影での計測は行っていない。
- Rust単体テスト36件成功。半画素境界・巻き方向の反転・回転／変形した四角形・矩形と変形した領域による穴の切り抜きを、独立した全画素走査と比較した。描画テスト1735件は変更前と判定・差分率が全件一致（pass 988 / fail 20 / skip 727）。公開API・ブラウザ／Workersサンプルの型チェック成功。WASMを再ビルド済み。
- 計測記録・不採用の試作・再実行方法: `target/benchmark/projection-neutral/`（生成物、gitignore）。最終比較は `baseline-final.json`。一般形のマスクを行ごとの複数区間に置き換える変更や、ラベルの方向を画面全体で固定する変更は行っていない。

### 三角形走査を行単位の被覆区間に限定 (2026-11-01)

- `for_each_pixel` は、三角形の外接矩形全体ではなく各行で被覆する画素区間を走査する。各辺の判定は行に沿って単調なので、端点が両方外ならその行を除外し、内外が変わる辺では交点から境界候補を求める。
- 候補と隣接画素を従来の辺関数で確認し、丸め・桁落ちで候補が合わない場合だけ同じ辺関数で二分探索する。非有限の辺計算は従来の画素ごとの判定に戻し、短い行は区間探索を省く。共有辺のtop-left規則、端点の正規化、重心座標の計算式・除算順序は維持。呼び出し側のAPIは変更していない。
- 基準は上記のフィルタ・グリフ・GeoJSON最適化をすべて含むWASM。Node 26.13.0 / SIMD WASM、取得済み素材、ウォームアップ2回後の7回の中央値。変更前後を交互に実行し、画像ごとのレンダラ生成・素材デコード・描画・破棄を含む。ネットワーク・WASM初期化・PNG圧縮は除外。東京は256 CSS px / DPR 2 / margin 64。

| ケース | 今回の変更前 | 変更後 | 時間削減 |
|---|---:|---:|---:|
| 東京 z14 | 256.4 ms | 237.8 ms | 7.3% |
| 東京 z16 | 203.8 ms | 152.6 ms | 25.1% |
| 東京 z18 | 137.1 ms | 92.9 ms | 32.3% |
| GeoJSON: 1500本×24頂点、8レイヤ | 16.3 ms | 15.8 ms | 3.0% |
| GeoJSON: 1万点のラベル | 47.0 ms | 47.3 ms | ほぼ変化なし |
| GeoJSON: 長い斜め線80本 | 164.2 ms | 9.1 ms | 94.5% |

- 最初の二分探索だけの試作から、交点候補の確認を先に行う方式に改善。WASMメモリ確保量は全ケースで変化なし。ブラウザでの追加計測は行っていない。
- 全計測試行でRGBAのSHA-256一致、各ケースのPNGバイト一致を確認。bearing 17° / DPR 1.5 / margin 0でもRGBA・PNGが一致。独立した全画素走査との比較テストで、極細・半画素境界・画面外・両巻き方向・大きな座標・退化三角形と乱数2000ケースについて、被覆と重心座標のビット一致を確認。
- Rust単体テスト35件成功。描画テスト1735件の判定・差分率は変更前と全件一致（pass 988 / fail 20 / skip 727）。公開API・ブラウザ／Workersサンプルの型チェック成功。WASMを再ビルド済み、1,902,701 bytes。SHA-256: `b57d71ecbfd925c6224714509340a1d177686c296c731dafa7d7369ef8083067`。
- 計測記録・基準／最終WASM・再実行方法: `target/benchmark/triangle-scan/`（生成物、gitignore）。最終比較は `baseline-hint.json`、要約は `summary.json`。

### フィルタ・グリフ依存探索・GeoJSONタイル生成の最適化 (2026-11-01)

- `bucket_features` は、座標を必要としないフィルタを通過した地物だけ座標変換する。`within` / `distance` を使うレイヤでは従来と同じEXTENT単位の座標を式に渡す。
- グリフ依存範囲はレンダラ内で再利用し、グリフ取得後の `needs()` と `render()` の準備完了チェックでテキストを再走査しない。ソース・タイル・画像の取得とカメラのクランプで破棄する。取得すべきURLは毎回、依存範囲から取得済み／失敗済み範囲を除いて求めるため、段階的取得や取得失敗の扱いを維持する。
- GeoJSONのクリップ・簡略化・量子化結果も、既存のMVT切り出しキャッシュと同じソース内の共有領域に保持する。canonical tileごとに再利用し、world wrapでも同じ結果を共有する。
- Node 26.13.0 / SIMD WASM、取得済み素材、ウォームアップ2回後の7回の中央値。変更前後を交互に実行し、画像ごとのレンダラ生成・素材デコード・描画・破棄を含め、ネットワーク・WASM初期化・PNG圧縮を除いて比較した。東京駅周辺は256 CSS px / DPR 2 / margin 64。

| ケース | 変更前 | 変更後 | 時間削減 |
|---|---:|---:|---:|
| 東京 z14 | 324.6 ms | 259.5 ms | 20.1% |
| 東京 z16 | 224.2 ms | 208.5 ms | 7.0% |
| 東京 z18 | 140.4 ms | 138.1 ms | 1.6%（小差） |
| GeoJSON: 1500本×24頂点、8レイヤ | 21.4 ms | 16.8 ms | 21.4% |
| GeoJSON: 1万点のラベル | 66.9 ms | 47.7 ms | 28.7% |

- 個別比較でも、座標変換の遅延とグリフ依存範囲の再利用は東京z14、GeoJSONタイル共有は複数レイヤのケースで改善を確認。衝突判定の訪問済み配列を世代番号で再利用する試作は、1万点ラベルでも47.0→47.1 msで改善せず、採用しなかった。この計測時点では三角形走査と画像ごとのスタイルコンパイルは変更していない。
- 各ケースの全計測試行でRGBAのSHA-256一致、計測後にPNGバイト一致を確認。さらに各ケースをbearing 17° / DPR 1.5 / margin 0でも比較し、RGBAとPNGの一致を確認。ブラウザでの追加計測は行っていない。
- WASMメモリの確保量は東京z14で151.625→151.688 MiB、z16・z18は変化なし。GeoJSON共有による保持で複数レイヤは32.75→33.81 MiB、1万点ラベルは55.31→57.06 MiBとなった。
- Rust単体テスト34件成功（段階的なソース取得、グリフ取得失敗、カメラクランプ後のグリフ要求の回帰テストを追加）。描画テスト1735件はpass 988 / fail 20 / skip 727で、全件の判定・差分率が変更前と一致。公開API・ブラウザ／Workersサンプルの型チェック成功。WASMを再ビルド済み。
- 計測記録・試作差分・再実行用スクリプト: `target/benchmark/render-optimization/`（生成物、gitignore）。最終比較は `baseline-final.json`。最新WASMのSHA-256は `ba777fcef40ea369a2489dee1b7453ea68b247a70cbb96f522be5a20a9b039d1`。

### 都会・高ズームの切り出し／マスク再利用 (2026-10-31)

- `tile.openstreetmap.jp/styles/openmaptiles/style.json` の東京駅周辺で調査。元データmaxzoom 14を超える描画で、同じMVTの切り出しとタイル境界マスクの生成をスタイルレイヤごとに繰り返していた。z16の計測では切り出し15,808回・約995ms、マスク150回・約324ms。
- 切り出し結果はソースごとに `(データタイルID, 描画先のcanonical ID)` で共有。glyph要求の計算と複数スタイルレイヤが同じ結果を利用する。world wrapはタイル内の座標を変えないため共有でき、異なるソース・切り出し先は混同しない。
- マスクの所有権は描画ごとに作る `render::Ctx` に置く。キーはフレームバッファ寸法と順序付きRenderTile集合（wrap含む）。親子タイルの被覆関係を保持し、カメラのクランプや次回描画のために手動でキャッシュを破棄する必要がない。
- 回帰テストは切り出しの共有・ソース／兄弟タイルの分離・元ズームへのクランプ、マスクの親子関係・順序・wrap・寸法、新しい描画コンテキストでの再投影を確認。Rust単体テスト32件成功。上流描画テスト全1735件は判定・差分率とも変更前と一致。
- 東京駅周辺、256 CSS px / DPR 2 / margin 64、取得済み素材でのNode/WASM中央値（ウォームアップ後5回）: z14 **643→333ms**、z16 **1591→224ms**、z18 **790→139ms**。各条件のPNGは変更前と完全一致。
- Chrome 156でz16を6組交互に測定し、中央値 **1469→214ms（約6.9倍）**、PNGのSHA-256一致を確認。ブラウザ本番ビルドとWrangler dry-run成功。最新WASMは約1.89 MB。記録: `target/benchmark/urban-openmaptiles/fixed-summary.json`（生成物、gitignore）。

### PNG出力・Cloudflare Workersロード (2026-10-31)

- Rust `Renderer::render_png()` とC ABI `renderer_render_png` を追加。既存の描画・margin切り出し後にRGBA8 PNGへ可逆圧縮し、共有出力バッファへ返す。純Rustの既存 `png` クレートを使用し、CPU時間を優先する `Compression::Fast` を選択。
- `MapRenderer.renderPng(view)` は独立した `Uint8Array<ArrayBuffer>` を返す。RGBAの `render()` とリソース取得・エラー処理を共有し、JSへのRGBA全体のコピーを挟まずPNGだけをコピーする。
- `MapRenderer.init(styleUrl, { wasm: WebAssembly.Module })` を追加。指定時は実行時のWASM取得・コンパイルを行わず、専用インスタンスを生成する。未指定のブラウザでは `new URL(..., import.meta.url)` のアセットを取得するため、公開APIからVite専用の `?url` importを除去。
- `ml2drender/renderer.wasm` を型定義付きで公開。WranglerがCompiledWasmとして認識できるよう、公開パスにも `.wasm` 拡張子を含める。
- `examples/workers/` にWranglerサンプルを追加。`pnpm demo:workers` でローカル起動し、`pnpm --filter demo-workers build` でデプロイせずバンドルを確認できる。コンパイル済みモジュールのみ共有し、リクエストごとにレンダラ・WASMメモリを作る。
- Rust単体テスト29件成功。半透明・小数DPR・marginのPNGラウンドトリップ、未取得リソースのエラーを確認。公開型・両サンプルの型チェック、Vite本番ビルド、Wrangler dry-run成功。
- ローカルworkerdで3並行リクエストのPNGレスポンス（Content-Type・PNG署名）を確認。ChromeでWorkers出力とRGBAの全画素一致、DPR 1 / 1.5 / 2 × margin 0 / 64 のPNG寸法・画素一致、既存Bitmap Workerを確認。モジュール注入時にWASM fetch・compileが呼ばれないこと、PNGバッファの保持、RGBA/PNG並行呼び出し、入力・スタイルのエラーも確認。
- WASMは1,880,411 bytes（約1.88 MB）。Cloudflare本番へのデプロイは行っていない。上記の上流描画・式評価テストの通過率はクラスタ統合時の全件実行結果。

### GeoJSONクラスタ・WASM最適化の統合 (2026-10-31)

- `995fc7e` の supercluster / kdbush、`clusterProperties` の map/reduce、GeoJSON ソース `filter` を現構成へ取り込み。ソース filter はクラスタ生成より前に適用し、非クラスタのソースにも適用する。
- クラスタ・集約プロパティ・ソースfilterの上流テスト3件が成功に変わり、描画テストは上記の通過率へ改善。単体テスト27件成功、式評価は581/583で変化なし。
- `713b451` の専用 `wasm` プロファイル（opt-level 3 / fat LTO / codegen-units 1 / panic abort / strip）と simd128 を取り込み。`pnpm build:wasm` は新プロファイルでビルドし、`target/wasm32-unknown-unknown/wasm/` の成果物を公開パッケージへコピーする。
- 最適化WASMは1,827,396 bytes（約1.83 MB）。型チェック・ブラウザ用本番ビルド成功。Chromeでクラスタ・集約プロパティ・ソースfilter・Hillshadeの各fixtureを margin 0 / 64 で描画し、Workerとメインで生成したBitmapの全画素一致を確認。
- 統合時に `phase6-symbol` のcore実装・WASM設定を再比較。機能の未取り込みは解消し、残る差は現在側の名称・配置・margin・追加テスト・インデント修正。JS API・Worker・デモは現在側の拡張を維持。

### DEM・Hillshade の復元 (2026-10-31)

- 別履歴の `54640b6` にあった `raster-dem` / hillshade / color-relief / heatmap の実装を、現在の `crates/` 構成へ復元。現ブランチではソース・描画処理・spec・テスト除外ルールが未反映で、JS API の対応レイヤ一覧と README だけが対応済みになっていた。
- DEM は mapbox / terrarium / custom encoding、TileJSON の tileSize・encoding、隣接タイルの境界補完、親タイルへのフォールバックに対応。既存の margin による切り出しを維持。
- DEM 取得から陰影描画までの回帰テストを追加し、margin 0 / 8 で確認。復元直後の Rust 単体テスト25件成功。現在の上流描画テスト結果は上記を参照。
- WASM 再ビルド済み。Chrome で上流の実DEMタイルを使い、margin 0 / 64 の両方で Worker の ImageBitmap と直接RGBA出力の全画素一致、陰影表示を確認。
- コピー削減・Worker 内 Bitmap 化を維持。受信側が破棄する Bitmap は `close()` する。

### 描画余白 (`margin`)

- `MapRenderer.render(view)` / Rust `View` に `margin` を追加（非負整数の CSS ピクセル、既定 0）。余白を含むタイル取得・symbol 配置・描画後に、元の出力サイズへ切り出す。WASM ABI の `renderer_new` にも引数を追加したため、ホストと WASM は一緒に更新する。
- 元のカメラ中心・ラスターのピクセル整列を保持。小数 DPR は余白をデバイスピクセルへ丸める。ブラウザデモは `margin: 64` CSS ピクセルを使用。
- 隣接タイルのアイコン、余白分のタイル取得、極域の中心維持、小数 DPR・回転時の射影とピクセル整列を単体テストで確認。margin はタイル間の独立した衝突判定による配置差を完全には解消しない。
- ブラウザデモの右側は MapLibre GL JS の raster ソースを使用。WASM Worker の生成画像を `addProtocol` 経由で `ImageBitmap` として渡し、左右の中心・ズームを同期。Leaflet 依存を削除。

### フェーズ2: 式評価(`crates/core/src/expression/`)

- style-spec `src/expression` の移植: 型システム、パース/型検査(エラーメッセージ・キーまで一致)、定数畳み込み、全演算子、`within` / `distance`、legacy function → expression 変換(テスト用)。
- JS 互換の細部: 数値の文字列化(`Number#toString`)、`JSON.stringify`、`Math.round`、`String()` 強制、UTF-16 順の文字列比較。
- 実行時の legacy function は upstream と同じく `createFunction` 相当(`expression/function.rs`)で評価する(変換版とは端の挙動が違う)。
- 失敗 2 件(`collator/variable-gt`, `collator/variable-lteq`): ロケール別照合(スウェーデン語の ä、ドイツ語 search 照合)が必要。照合はルート照合のみ・`resolved-locale` は英語以外 `en-US` に解決する設計上の制約。

### フェーズ3: MVT / GeoJSON + background / fill / line / circle

- **ソフトウェア GL**(`render/raster.rs`): MSAA なしの GL と同じく、画素中心サンプリングの三角形ラスタライズ + 各シェーダの AA 計算をそのまま再現。unorm8 のプリマルチプライド合成。tile clip は stencil 相当のマスク。
- MVT デコード(protobuf 手書き、gzip 対応)。GeoJSON は geojson-vt 移植(簡略化・buffer 付きクリップ・世界ラップ・rewind・量子化・lineMetrics)。
- LineBucket の移植(join/cap/miter/bevel/flipbevel/fakeround/sharp corner/line-offset)、dash(LineAtlas SDF)、line-gradient(color ramp テクスチャ)、`*-layer-opacity`(オフスクリーン合成)、translate、sort-key、overzoom。
- 上流の「実装上の癖」も再現している(これをやらないと一致しない):
  - extrude ベクトルを Uint8/Int8 属性に格納する際の桁あふれ(miter-limit が大きいと継ぎ目が欠ける)。
  - GL の top-left 規則は y-up 窓座標基準 → y-down バッファでは「左辺 + 下辺」を含む。
  - `linesofar` の 1/2 量子化と長い線での距離リセット。
  - MapLibre 5.x の overzoom タイル分割(`zoomLevelsToOverscale` = 4): maxzoom を超えて `map.maxZoom - 4` までは親タイルを切り出し、vt-pbf 再エンコード時の差分整数切り捨てまで再現。
  - 背景はワールドの縦範囲内のみ描画。`background-pattern` が設定されていて解決できなければ背景を描かない。
- WASM: 1.16 MB(未最適化)。demotiles を Node から wasm 経由で描画できることを確認(TileJSON → タイル 4 枚 → 66 ms)。

### フェーズ4: raster / image ソース / sprite / pattern

- 画像デコード: PNG(`png`)、JPEG(`zune-jpeg`)、WebP(`image-webp`)。いずれも純 Rust・wasm32 確認済み。テクスチャはアップロード時に丸め付きでプリマルチプライ、raster タイルは box フィルタのミップマップ付き(`LINEAR_MIPMAP_NEAREST` 相当の λ 選択)、image ソースはミップマップなし。
- raster シェーダ移植(hue-rotate / saturation / contrast / brightness / opacity / resampling)、ピクセル整列射影(`_alignedProjMatrix`)、image ソースの射影ワープ(`calculateImageWarp`、必要時 16×16 分割メッシュ)。
- 欠落タイルの扱いを上流どおりに: vector の 404 は空タイル、raster の 404 は祖先タイル(`maxUnderzooming` = 10 段まで)で代替、raster の空レスポンス(204)は透明タイル。重なったタイルは高ズーム優先でマスク。
- sprite: `@2x`(pixelRatio > 1)、配列形式(`id:name`)、パターンは 1px ラップ付きパディング(ImageAtlas と同じ)。background / fill / line pattern、SDF パターン(`fwidth` は三角形ごとの varying 勾配から再現)、パターン付き fill outline。
- 三角形ラスタライズの共有辺を厳密化(辺関数を正規化した端点から評価し、隣接三角形で完全に符号反転させる)。
- WASM: 1.6 MB(未最適化、画像デコーダ 3 種込み)。

### フェーズ6: symbol(`crates/core/src/symbol/`)

- `glyphs.rs`: PBF グリフのパースと fontstack×256 コードポイント単位の範囲ストア。`needs()` はデコード済みタイルの text を評価してから範囲 URL を返す(style → タイル → グリフの段階的確定)。縦書きで置換されうる句読点の範囲も上流どおり要求する。
- `shaping.rs`: `shapeText`/`TaggedString` の移植(badness 最小の改行、justify、anchor 揃え、formatted のセクション・scale・vertical-align・画像、`shapeIcon`/`fitIconToText`/`applyTextFit`)。縦書き(`isLineVertical`、line ラベルの `determineLineVerticals`、句読点の縦書き形 `verticalizePunctuation`)。
- `layout.rs`: `SymbolBucket.populate` + `performSymbolLayout`(トークン解決、`text-transform`、point / line / line-center / polygon(pole of inaccessibility)のアンカー、`mergeLines`、`anchorIsTooClose`、text-size/icon-size の SizeData(constant/source/camera/composite、上流と同じ 128 倍パック)、quad(縦グリフの -90° 回転、icon-text-fit の nine-patch stretch)、Int16 に落とす衝突ボックス、variable anchor のオフセット)。
- `placement.rs`: `GridIndex`/`CollisionIndex`/`Placement` の移植(viewport padding 100、overlap never/always/cooperative、ignore-placement、optional、variable anchor の 2 パス、writing-mode 順の横/縦配置、line ラベルの collision circle、sort-key のタイル横断ソート、viewport-y、`crossSourceCollisions`)。fadeDuration 0 の定常状態 = 「配置されたものだけ表示」。
- `projection.rs`: `placeGlyphsAlongLine` / `placeGlyphAlongLine`(line-offset、keep-upright の反転、急勾配で縦書きへ切替える `useVertical`)。pitch 0 前提でラベル平面は画面(CSS px)。
- `draw.rs`: `symbol_sdf`/`symbol_icon`/`symbol_text_and_icon` シェーダの再現(SDF のしきい値・gamma・halo、halo と本体の 1 パス/2 パス切替 `isGlyphOverlap`、LINEAR/NEAREST の選択、`a_offset` の 1/32 量子化、`pixelOffset`/`minFontScale` の Int16)。タイルとシンボルの描画順(地図回転込み)、sort-key の区間ソート。
- 上流の癖で再現しているもの: layout が同一のレイヤは 1 つのバケットを共有し配置は先頭レイヤ分のみ(同じラベルが 2 回描かれる)、`text-size`(camera)のサイズはタイルズーム+1 の値で頭打ち、衝突ボックスは Int16 に切り捨て、描画時の layout 値は地図ズームで評価(バケットはタイルズーム)。
- API 追加: `Renderer::set_cross_source_collisions(bool)`(MapLibre の Map オプション。render テストの `crossSourceCollisions`)。
- 実スタイル確認: demotiles(国名ラベル)と OpenFreeMap liberty(東京、CJK・アイコン・シールド・line ラベル)を WASM 経由で描画できることを確認。WASM 1.86 MB(未最適化)。

## 未対応・既知の問題

### symbol の残り失敗 20 件

| 件数 | テスト | 原因 |
|---|---|---|
| 9 | `text-arabic/*`, `text-field/formatted-arabic`, `text-writing-mode/point_label/cjk-arabic-vertical-mode` | 双方向テキスト(bidi)とアラビア文字の字形整形が未実装(論理順のまま並べる)。 |
| 5 | `is-supported-script/*`, `text-local-glyphs/complex-script`, `regressions/mapbox-gl-native#11729`, `geometry-type/all-geometries` | MapLibre 6 は複合文字スクリプト(デーヴァナーガリー、クメール等)や取得できなかったグリフ範囲をブラウザのフォントで描く(TinySDF)。フォントを持たないため再現不可(グリフは欠落扱い)。 |
| 1 | `text-variable-anchor/rotated-offset` | 上流はタイルが届くたびに再配置し、前回のアンカーを優先して試す(`prevAnchor`)。1 回の配置ではこの履歴依存を再現できない。 |
| 5 | `visibility/symbol/visible`(0.0027), `symbol-placement/line-overlap`(0.0041), `text-field/formatted-images`(0.00043), `symbol-placement/point-polygon-high-zoom`(0.00026), `combinations/symbol-translucent--fill-translucent`(0.00098) | 小差分。visible は期待画像で一部アイコンの上下 1px が欠ける(原因未特定、NEAREST の texel 境界を疑ったが丸めでは変わらず)。line-overlap は z22 の line ラベルが約 0.5px ずれる(未特定)。translucent は fill のアウトライン右端の AA。 |

### その他

1. composite 式(zoom と feature の両方に依存)は表示ズームで直接評価している。MapLibre はタイルズームの前後で評価してシェーダで補間するため、指数補間などでわずかに差が出うる(symbol のサイズは上流どおりパックして補間)。
2. タイル欠落時の親/子タイルでの穴埋め(MapLibre の retained tiles)未対応。symbol の CrossTileSymbolIndex(ズーム間の重複除去)も未実装(同一ズームのタイル間では不要)。
3. feature-state は常に空(静的レンダリングのため仕様上も対象外)。
4. 照合はルート照合のみ。`number-format` は en-US の書式のみ(通貨・単位は主要なもの)。
5. `is-supported-script` は常に true。
6. symbol: グラフェムクラスタは 1 コードポイントずつ扱う(MapLibre もグリフファイルに無いクラスタはそうする)。単語区切りの無いスクリプト(タイ語等)の改行位置は未対応。`font-faces` と縦書き用グリフ variant は対象外。pitch 前提のコード(遠近補正、pitched label plane)は pitch 0 に簡約。
7. Unicode 文字種判定(縦書きの upright/neutral、句読点・記号、Nd/Lu)は範囲表と std の近似。

## 次フェーズの前提

- フェーズ5(sans-IO API の確定 + WASM + JS ホスト)の人間レビューが未実施。`needs()` の段階は style → (TileJSON / GeoJSON / sprite json+png / image) → タイル → (欠落 raster の祖先 / グリフ範囲)。グリフ範囲はデコード済みタイルの text 評価で確定し、データとカメラが変わらなければ再利用する(`provide()` は直前の `needs()` が返したグリフ URL を引くだけ。したがってグリフ範囲は `needs()` が返した URL でのみ受け付ける)。
- 現 API: `Renderer::new(style, View)` / `set_max_zoom` / `set_cross_source_collisions` / `needs()` / `provide(url, Option<bytes>)` / `render()`。`provide(None)` の意味は上流の 404 に合わせている(vector は空、raster は祖先、グリフ範囲は欠落)。
- WASM は専用 `wasm` プロファイルと simd128 でビルド（上記）。spec.json の縮小や画像デコーダの feature 化は将来のサイズ削減候補。
- CLI ランナーはハーネス依存の挙動(maxCanvasSize による DPR 縮小、`readPixels` の左下切り出し、`maxZoom`、`crossSourceCollisions`、`sparse204` の 204 応答)を再現済み。
