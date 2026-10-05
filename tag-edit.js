function unique(tags) {
  return [...new Set(tags)];
}

// 戻り値は「タグが変わる写真」だけの { id, tags } の一覧。呼び出し側がそれを反映して保存する。
export function renameTagInPhotos(photos, from, to, maxTags) {
  return photos
    .filter(photo => (photo.tags || []).includes(from))
    .map(photo => ({ id: photo.id, tags: unique(photo.tags.map(tag => tag === from ? to : tag)).slice(0, maxTags) }));
}

export function removeTagFromPhotos(photos, tag) {
  return photos
    .filter(photo => (photo.tags || []).includes(tag))
    .map(photo => ({ id: photo.id, tags: photo.tags.filter(item => item !== tag) }));
}

export function renameInList(list, from, to) {
  return unique(list.map(item => item === from ? to : item));
}

export function removeFromList(list, tag) {
  return list.filter(item => item !== tag);
}

export function countTag(photos, tag) {
  return photos.filter(photo => (photo.tags || []).includes(tag)).length;
}

// 「自分で作ったタグ」= 初期タグ以外で、保存済みの一覧か写真に付いているもの
export function manageableTags(defaultTags, customTags, photos) {
  const fromPhotos = photos.flatMap(photo => photo.tags || []);
  return unique([...customTags, ...fromPhotos]).filter(tag => !defaultTags.includes(tag));
}
