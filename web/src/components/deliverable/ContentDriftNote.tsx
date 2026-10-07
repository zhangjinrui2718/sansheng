/**
 * 交付物正文 · **索引漂移**那一行提示(`ArtifactContentView.drifted`)
 *
 * ── 它说的是什么 ────────────────────────────────────────────────
 *
 * 正文是项目仓里的一份文件,而 `artifacts.body_sha256` 是**写入那一刻**的快照。
 * 用户(或别的 agent)手改了盘上那份之后两者就不再相同 —— 读面用
 * `drifted` 如实报出这件事(判据:`sha256 !== indexedSha256`,见契约)。
 *
 * ── 为什么它必须是一行**提示**,不是红色错误 ──────────────────────
 *
 * 索引落后**不是故障,是还没收口**:`commitWorkspace`(设计 §3.4)会在下一次
 * 提交时扫一遍工作树、重算 sha256 并回填 `commit_sha`,索引随即收回一致。
 * 而屏幕上此刻显示的正文**正好就是盘上真值**(用户刚改的那一份)。
 * 画成红色错误会让用户以为正文坏了 —— 那是把「索引旧了」说成「内容没了」,
 * 与这个项目反复守的「读不到 ≠ 空」是同一类错。
 *
 * ⚠️ **不许阻止阅读。** 提示只是正文上方的一行,内容照常渲染。
 * ⚠️ 三个正文渲染点(HtmlReport / CodeService / Works 的普通正文)共用这一处,
 * 免得三份文案各自长歪(`data-content-drifted` 是给 SSR 判据用的判别键)。
 */

/**
 * 漂移提示的文案;**不漂移返回 `null`**(那时不该渲染任何东西 ——
 * 一句「一切正常」会把一条每次都出现的噪音变成用户要读的东西)。
 */
export function contentDriftNote(drifted: boolean): string | null {
  return drifted
    ? "盘上这份与索引里记的不是同一份(有人手改过文件?)—— 下一次提交会重建索引收回一致,这不是故障。"
    : null;
}

/** 一行提示。`drifted === false` 时**不渲染任何东西**(返回 `null`)。 */
export function ContentDriftNote({ drifted }: { drifted: boolean }) {
  const text = contentDriftNote(drifted);
  if (text === null) return null;
  return (
    <div
      className="ss-note"
      data-content-drifted="true"
      title="正文住在项目仓的文件里,而 artifacts.body_sha256 是写入那一刻的快照。手改文件之后索引就旧了 —— 下一次提交会重建索引收回一致。"
    >
      {text}
    </div>
  );
}
