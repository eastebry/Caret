define([
  "ui/projectManager",
  "storage/file",
  ],
function(projectManager, File) {
  var WebViewer = function(port, directory) {
    
    this.directory = directory;
    this.tcpServer = chrome.sockets.tcpServer;
    this.tcpSocket = chrome.sockets.tcp;
  
    this.serverSocketId = null;
    this.filesMap = projectManager.pathMap;
    this.port = port;
    this.host = '127.0.0.1' // listen only on localhost
    
  };
  
  WebViewer.prototype.stringToUint8Array = function(string) {
    var buffer = new ArrayBuffer(string.length);
    var view = new Uint8Array(buffer);
    for (var i = 0; i < string.length; i++) {
      view[i] = string.charCodeAt(i);
    }
    return view;
  };

  WebViewer.prototype.arrayBufferToString = function(buffer) {
    var str = '';
    var uArrayVal = new Uint8Array(buffer);
    for (var s = 0; s < uArrayVal.length; s++) {
      str += String.fromCharCode(uArrayVal[s]);
    }
    return str;
  };

  WebViewer.prototype.logToScreen = function(log) {
    logger.textContent += log + "\n";
    logger.scrollTop = logger.scrollHeight;
  };

  WebViewer.prototype.destroySocketById = function(socketId) {
    this.tcpSocket.disconnect(socketId, function() {
      this.tcpSocket.close(socketId);
    });
  };

  WebViewer.prototype.closeServerSocket = function() {
    if (this.serverSocketId) {
      this.tcpServer.close(this.serverSocketId, function() {
        if (chrome.runtime.lastError) {
          console.warn("chrome.sockets.tcpServer.close:", chrome.runtime.lastError);
        }
      });
    }
    
    // TODO - what do I do about these? this is not going to work
    this.tcpServer.onAccept.removeListener(this.onAccept);
    this.tcpSocket.onReceive.removeListener(this.onReceive);
  };

  WebViewer.prototype.sendReplyToSocket = function(socketId, buffer, keepAlive) {
    // verify that socket is still connected before trying to send data
    var that = this;
    this.tcpSocket.getInfo(socketId, function(socketInfo) {
      if (!socketInfo.connected) {
        that.destroySocketById(socketId);
        return;
      }

      that.tcpSocket.setKeepAlive(socketId, keepAlive, 1, function() {
        if (!chrome.runtime.lastError) {
          that.tcpSocket.send(socketId, buffer, function(writeInfo) {
            console.log("WRITE", writeInfo);

            if (!keepAlive || chrome.runtime.lastError) {
              that.destroySocketById(socketId);
            }
          });
        }
        else {
          console.warn("chrome.sockets.tcp.setKeepAlive:", chrome.runtime.lastError);
          that.destroySocketById(socketId);
        }
      });
    });
  };

  WebViewer.prototype.getResponseHeader = function(file, errorCode, keepAlive, size) {
    var httpStatus = "HTTP/1.0 200 OK";
    var contentType = "text/plain";
    var contentLength = 0;

    if (!file || errorCode) {
      httpStatus = "HTTP/1.0 " + (errorCode || 404) + " Not Found";
    }
    else {
      contentType = file.type || contentType;
      contentLength = size;
    }

    var lines = [
      httpStatus,
      "Content-length: " + contentLength,
      "Content-type:" + contentType
    ];

    if (keepAlive) {
      lines.push("Connection: keep-alive");
    }

    return this.stringToUint8Array(lines.join("\n") + "\n\n");
  };

  WebViewer.prototype.getErrorHeader = function(errorCode, keepAlive) {
    return this.getResponseHeader(null, errorCode, keepAlive);
  };

  WebViewer.prototype.getSuccessHeader = function(file, keepAlive, size) {
    return this.getResponseHeader(file, null, keepAlive, size);
  };

  WebViewer.prototype.writeErrorResponse = function(socketId, errorCode, keepAlive) {
    console.info("writeErrorResponse:: begin... ");

    var header = this.getErrorHeader(errorCode, keepAlive);
    console.info("writeErrorResponse:: Done setting header...");
    var outputBuffer = new ArrayBuffer(header.byteLength);
    var view = new Uint8Array(outputBuffer);
    view.set(header, 0);
    console.info("writeErrorResponse:: Done setting view...");

    this.sendReplyToSocket(socketId, outputBuffer, keepAlive);

    console.info("writeErrorResponse::filereader:: end onload...");
    console.info("writeErrorResponse:: end...");
  };

  WebViewer.prototype.write200Response = function(socketId, file, keepAlive) {
    file = new File(file.entry);
    var that = this;
    file.readAsArrayBuffer(function(err, response){
      if (!err){
        var header = that.getSuccessHeader(file.entry.file, keepAlive, response.bytelength);
        var outputBuffer = new ArrayBuffer(header.byteLength + response.byteLength);
        var view = new Uint8Array(outputBuffer);
        // TODO bryan - this seems to be where it is faling currently
        view.set(header, 0);
        view.set(new Uint8Array(response), header.byteLength);
        that.sendReplyToSocket(socketId, outputBuffer, keepAlive);
      }
    });

  };

  WebViewer.prototype.onAccept = function(acceptInfo) {
    this.tcpSocket.setPaused(acceptInfo.clientSocketId, false);

    if (acceptInfo.socketId != this.serverSocketId)
      return;

    console.log("ACCEPT", acceptInfo);
  };

  WebViewer.prototype.onReceive = function(receiveInfo) {
    console.log("READ", receiveInfo);
    var socketId = receiveInfo.socketId;

    // Parse the request.
    var data = this.arrayBufferToString(receiveInfo.data);
    // we can only deal with GET requests
    if (data.indexOf("GET ") !== 0) {
      // close socket and exit handler
      this.destroySocketById(socketId);
      return;
    }

    var keepAlive = false;
    if (data.indexOf("Connection: keep-alive") != -1) {
      keepAlive = true;
    }

    var uriEnd = data.indexOf(" ", 4);
    if (uriEnd < 0) { /* throw a wobbler */ return; }
    var uri = data.substring(4, uriEnd);
    // strip query string
    var q = uri.indexOf("?");
    if (q != -1) {
      uri = uri.substring(0, q);
    }
    var file = this.filesMap[uri];
    console.log(file)
    if (!!file == false) {
      console.warn("File does not exist..." + uri);
      this.writeErrorResponse(socketId, 404, keepAlive);
      return;
    }
    //logToScreen("GET 200 " + uri);
    this.write200Response(socketId, file, keepAlive);

  };

  WebViewer.prototype.onDirectoryChange = function(projectMap) {
    this.closeServerSocket();
    
    // TODO - do something here. Probably all you need to do is refresh
    // the project map

  };

  WebViewer.prototype.start = function() {
    var that = this;
    this.tcpServer.create({}, function(socketInfo) {
      that.serverSocketId = socketInfo.socketId;

      that.tcpServer.listen(that.serverSocketId, that.host, that.port, 50, function(result) {
        console.log("LISTENING:", result);

        that.tcpServer.onAccept.addListener(function(anything){that.onAccept(anything)});
        that.tcpSocket.onReceive.addListener(function(anything){that.onReceive(anything)});
      });
    });
  };
  
  WebViewer.prototype.stop = function() {
    console.log("STOPPING");
    this.closeServerSocket();
  }
  
  return WebViewer;

});
