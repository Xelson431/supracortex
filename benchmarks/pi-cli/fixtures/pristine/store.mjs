export class Store {
  constructor() {
    this.map = new Map();
  }
  set(key, value) {
    this.map.set(key, value);
  }
  get(key) {
    return this.map.get(key);
  }
}
