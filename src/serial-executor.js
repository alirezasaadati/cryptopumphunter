export function createSerialExecutor() {
  let tail = Promise.resolve();
  return function runSerial(task) {
    const current = tail.then(task);
    tail = current.catch(() => {});
    return current;
  };
}
