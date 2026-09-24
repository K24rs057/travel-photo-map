// 「家族の箱(Googleドライブの共有フォルダ)」と「端末に保存済みの家族の写真」を
// 比べて、足す・消すを決めたり、自分の写真が家族に共有済みかどうかを判定したりする
// 純粋なロジック。通信やIndexedDBには一切触れないので、テストしやすい。

// remoteMeta: drive.listFamilyPhotos()が返す配列(id, modifiedTime など)
// localRecords: db.allFamilyPhotos()が返す配列(前回の同期で保存した内容)
// 新規・更新が必要なものはtoFetchへ、家族の箱から消えた(または権限がなくなった)ものはtoRemoveへ。
export function diffFamilySync(remoteMeta, localRecords) {
  const localById = new Map(localRecords.map(record => [record.id, record]));
  const remoteIds = new Set(remoteMeta.map(file => file.id));
  const toFetch = remoteMeta.filter(file => {
    const local = localById.get(file.id);
    return !local || local.modifiedTime !== file.modifiedTime;
  });
  const toRemove = localRecords.filter(record => !remoteIds.has(record.id)).map(record => record.id);
  return { toFetch, toRemove };
}

// 自分の写真(photos)に、家族の箱に届いているかどうかの印(shared)をつける。
// driveIdが家族の箱の一覧(remoteMeta)に含まれていれば「共有済み」、
// 未アップロード、または以前できた別フォルダに送られている場合は「未共有」。
export function annotateShareStatus(ownPhotos, remoteMeta) {
  const remoteIds = new Set(remoteMeta.map(file => file.id));
  return ownPhotos.map(photo => ({ ...photo, shared: Boolean(photo.driveId && remoteIds.has(photo.driveId)) }));
}

// 「家族」タブに並べる一覧を組み立てる。
// - 家族の箱にある写真(自分がアップロードして共有済みのものも含む)はfamilyRecordsからそのまま
// - 自分が撮ったがまだ共有していない写真は、二重に並ばないようにfamilyRecordsに無いものだけ追加
export function buildFamilyView(familyRecords, ownPhotosAnnotated) {
  const familyIds = new Set(familyRecords.map(record => record.id));
  const shared = familyRecords.map(record => ({
    key: `family-${record.id}`,
    id: record.id,
    date: record.date,
    tags: Array.isArray(record.tags) ? record.tags : [],
    owner: record.owner || "",
    thumb: record.thumb || null,
    full: record.full || null,
    shared: true,
    own: false,
  }));
  const unshared = ownPhotosAnnotated
    .filter(photo => !photo.shared && !(photo.driveId && familyIds.has(photo.driveId)))
    .map(photo => ({
      key: `own-${photo.id}`,
      id: photo.id,
      date: photo.date,
      tags: Array.isArray(photo.tags) ? photo.tags : [],
      owner: "",
      thumb: photo.thumb || null,
      full: photo.blob || null,
      shared: false,
      own: true,
      localId: photo.id,
    }));
  return [...shared, ...unshared].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}
