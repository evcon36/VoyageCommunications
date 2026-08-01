// Таймлайн активных говорящих во время записи (в памяти).
// Клиенты шлют socket 'rec-speaker' пока идёт запись; на стопе таймлайн
// сохраняется в БД и используется при транскрибации для разметки по никам.
const timelines = new Map();   // recordingId -> [{ t, speaker }]
const roomToRec = new Map();   // roomId -> recordingId (активная запись)

module.exports = {
  startRec(roomId, recId) {
    roomToRec.set(roomId, recId);
    timelines.set(recId, []);
  },
  addSpeaker(roomId, speaker, t) {
    const recId = roomToRec.get(roomId);
    if (!recId || !speaker) return;
    const arr = timelines.get(recId);
    if (!arr) return;
    const last = arr[arr.length - 1];
    if (last && last.speaker === speaker) return; // дедуп подряд идущих
    arr.push({ t, speaker });
  },
  endRec(recId) {
    const arr = timelines.get(recId) || [];
    timelines.delete(recId);
    for (const [room, id] of roomToRec) if (id === recId) roomToRec.delete(room);
    return arr;
  },
};
