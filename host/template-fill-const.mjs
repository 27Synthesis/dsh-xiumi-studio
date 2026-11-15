/** 零宽空格：文字槽唯一的「清空」写法（放单独文件，避免 layout.mjs 与 template-fill.mjs 循环引用） */
export const BLANK_TEXT = '\u200b';
/**
 * 1200×2 的透明 PNG（base64），用来把模板自带的照片从图片槽里顶掉。
 * 为什么不用 1×1：图片块按原始宽高比铺满栏宽，1×1 会撑成一个正方形的大空块；
 * 1200×2 铺满后只有一条 1px 细线，视觉上等于「这个槽位不存在」。
 */
export const BLANK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAABLAAAAACCAYAAABIbCWiAAAAIElEQVR42u3BMQEAAADCoPVPbQdvoAAAAAAAAAAAAPgMJYIAAZXvrhgAAAAASUVORK5CYII=';
