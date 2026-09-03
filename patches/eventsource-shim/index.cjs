function EventSource(url, _opts) {
  if (!(this instanceof EventSource)) {
    return new EventSource(url, _opts);
  }
  this.url = url;
  this.readyState = 0;
  this.onopen = null;
  this.onmessage = null;
  this.onerror = null;
}
EventSource.CONNECTING = 0;
EventSource.OPEN = 1;
EventSource.CLOSED = 2;
EventSource.prototype.addEventListener = function () {};
EventSource.prototype.removeEventListener = function () {};
EventSource.prototype.close = function () {
  this.readyState = 2;
};
module.exports = EventSource;
module.exports.EventSource = EventSource;
module.exports.default = EventSource;
