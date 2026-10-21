const guide = {
  front: ['點一下，進入音樂。', '點擊專輯封面切換播放／暫停。游標移到封面，左右兩側會出現上一首與下一首；拖動封面則會旋轉方塊。', 'CLICK TO PLAY · DRAG TO TURN'],
  volume: ['音量，轉到剛剛好。', '沿著右側音量環拖動，或使用滑鼠滾輪調整音量。點擊中央切換靜音；能否控制音量，依播放器與播放裝置支援而定。', 'DRAG THE RING · SCROLL TO ADJUST'],
  top: ['把時間，握在手裡。', '點唱片切換播放／暫停；轉動唱片快轉或倒轉，一圈約 10 秒，放開後跳轉。游標移上去時，中央會出現播放佇列按鈕。', 'TURN TO SEEK · RELEASE TO JUMP'],
  tools: ['歌詞的工具，翻面就到。', '背面的 SOURCE 切換歌詞來源，FIND 搜尋並匹配其他版本，RELOAD 重新取得歌詞。', 'SOURCE · FIND · RELOAD'],
  window: ['讓視窗，配合你的習慣。', 'FOLLOW 切換歌詞自動跟隨，PIN 讓視窗保持置頂，MINI 切換精簡模式。精簡模式的控制配置不同，請看實際錄影。', 'FOLLOW · PIN · MINI']
};
const hotspotInfo = {
  play: ['播放／暫停', '在 App 點封面即可切換播放或暫停；彩色封面代表播放中，灰階代表暫停。拖動封面只會旋轉方塊。'],
  previous: ['上一首', '在 App 將游標移到封面，左側會出現上一首按鈕。播放控制依所選播放器的支援與授權而定。'],
  next: ['下一首', '在 App 將游標移到封面，右側會出現下一首按鈕，按下可切換歌曲。'],
  volume: ['音量環', '沿環拖動或捲動滑鼠滾輪調整音量；放開或停止捲動後提交。裝置不支援音量控制時，此功能會停用。'],
  mute: ['靜音／取消靜音', '點音量環中央切換靜音。ytmdesktop 取消靜音時保留原音量；其他支援音量控制的播放器從非零音量切到 0%，從 0% 取消時設為 100%。'],
  queue: ['播放佇列', '游標移到唱片時，中央會顯示佇列按鈕。點一下開啟，點第二次或按 Esc 關閉。ytmdesktop 可直接點播；Spotify 跳轉需要 Premium；ytmdesktop2 只能查看曲名。'],
  seek: ['轉動唱片', '在 App 轉動唱片可預覽快轉或倒轉，一圈約 10 秒，放開時才跳轉；點唱片則切換播放／暫停。'],
  source: ['SOURCE · 歌詞來源', '選擇這首歌偏好的歌詞來源，或恢復自動搜尋。每首歌的選擇會保存在本機。'],
  find: ['FIND · 搜尋歌詞', '輸入歌名或歌手尋找其他版本，預覽後以 Use these lyrics 綁定這首歌；Restore automatic 可恢復自動搜尋。'],
  reload: ['RELOAD · 重新取得', '略過下載快取，重新向來源取得目前歌曲的歌詞；有手動匹配時，會更新所選候選的歌詞。'],
  follow: ['FOLLOW · 跟隨歌詞', '控制是否自動捲動到目前歌詞。有同步時間時跟隨播放高亮，純文字歌詞不會猜測時間。'],
  pin: ['PIN · 保持置頂', '讓 Hakuro 留在其他視窗上方。置頂時才能使用滑鼠穿透；Ctrl+Alt+P 可切換穿透狀態。'],
  mini: ['MINI · 精簡模式', '收起完整視窗，留下沒有背景的方塊。也能展開三行歌詞；精簡模式的音量在左側、視窗控制在頂部。']
};
const cube = document.querySelector('.cube');
const scene = document.querySelector('.cube-scene');
const panel = document.getElementById('guide-panel');
const angles = { front: [-29, -36], volume: [-16, -105], top: [-72, -20], tools: [-18, -196], window: [-18, 105] };
let rotation = [...angles.front];
let drag;
let suppressClick = false;

function describe(title, description, gesture, labelledBy) {
  panel.querySelector('h3').textContent = title;
  panel.querySelector('p').textContent = description;
  panel.querySelector('.gesture').textContent = gesture;
  panel.setAttribute('aria-labelledby', labelledBy);
}

function renderCube() {
  const [x, y] = rotation.map(value => value * Math.PI / 180);
  const front = Math.cos(y) * Math.cos(x);
  const right = -Math.sin(y) * Math.cos(x);
  const top = -Math.sin(x);
  const visibility = { front, right, top, back: -front, left: -right, bottom: -top };
  cube.style.transform = 'rotateX(' + rotation[0] + 'deg) rotateY(' + rotation[1] + 'deg)';
  cube.querySelectorAll('.face').forEach(face => {
    const visible = visibility[face.dataset.side] > 0.12;
    face.setAttribute('aria-hidden', String(!visible));
    face.inert = !visible;
    face.querySelectorAll('.hotspot').forEach(button => { button.tabIndex = visible ? 0 : -1; });
  });
}

document.querySelectorAll('[role="tablist"]').forEach(list => {
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  function activate(tab) {
    tabs.forEach(item => {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      if (!item.dataset.view) document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
    });
    if (tab.dataset.view) {
      cube.dataset.face = tab.dataset.view;
      rotation = [...angles[tab.dataset.view]];
      renderCube();
      describe(...guide[tab.dataset.view], tab.id);
    }
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', event => {
      const vertical = list.getAttribute('aria-orientation') === 'vertical';
      let next;
      if (event.key === (vertical ? 'ArrowDown' : 'ArrowRight')) next = (index + 1) % tabs.length;
      if (event.key === (vertical ? 'ArrowUp' : 'ArrowLeft')) next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      activate(tabs[next]);
      tabs[next].focus();
    });
  });
});

cube.querySelectorAll('.hotspot').forEach(button => {
  button.id = 'hotspot-' + button.dataset.hotspot;
  button.setAttribute('aria-controls', 'guide-panel');
  button.setAttribute('aria-describedby', 'guide-description');
  function explain() {
    if (drag?.moved || suppressClick) return;
    describe(...hotspotInfo[button.dataset.hotspot], 'APP CONTROL / 操作說明', button.id);
  }
  button.addEventListener('pointerenter', explain);
  button.addEventListener('focus', explain);
  button.addEventListener('click', explain);
});

scene.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !event.isPrimary) return;
  suppressClick = false;
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, rotation: [...rotation], moved: false };
});
scene.addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.id) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 6) return;
  drag.moved = true;
  scene.setPointerCapture(event.pointerId);
  scene.classList.add('is-dragging');
  rotation = [Math.max(-80, Math.min(80, drag.rotation[0] - dy * 0.5)), drag.rotation[1] + dx * 0.6];
  renderCube();
});
function finishDrag(event) {
  if (!drag || event.pointerId !== drag.id) return;
  suppressClick = drag.moved;
  drag = undefined;
  scene.classList.remove('is-dragging');
  if (scene.hasPointerCapture(event.pointerId)) scene.releasePointerCapture(event.pointerId);
  // Suppress the click generated by pointerup after rotation.
  setTimeout(() => { suppressClick = false; }, 0);
}
window.addEventListener('pointerup', finishDrag);
scene.addEventListener('pointercancel', finishDrag);
scene.addEventListener('lostpointercapture', finishDrag);
renderCube();
