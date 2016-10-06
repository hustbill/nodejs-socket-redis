//var io = require('socket.io').listen(80)
var app = require('http').createServer(handler)
    , io = require('socket.io').listen(app)

app.listen(80);

function handler(req, res) {
    if (req.url == "/monitor") {
        res.writeHead(200);
        res.end("OK");
    }
    else {
        res.writeHead(404);
        res.end();
    }
}

//io.disable('heartbeats')
//io.set('heartbeats', false);
io.set('transports', ['websocket', 'xhr-polling']);
io.set('heartbeat timeout', 5 * 60)
io.set('heartbeat interval', 4 * 60)
io.set('close timeout', 1 * 30);
io.set("log level", 1)
io.set("browser client", false)
io.set("browser client cache", false)
io.set("browser client cache", false)
var redis = require("redis")
var pub = redis.createClient()
var store = redis.createClient()
var snschat = redis.createClient()
var notification = redis.createClient()
var PUSH_TO_IOS_DELAY_TIME = 120000
snschat.subscribe("snschat");
notification.subscribe("notification")
var sockets = {}

pub.on("error", function (err) {
    console.log("Error " + err);
});

store.on("error", function (err) {
    console.log("Error " + err);
});

snschat.on("error", function (err) {
    console.log("Error " + err);
});

function send_msg_delay(socket) {
    store.hget("chat_history", socket.userid, function (e, v) {
        if (v) {
            list = JSON.parse(v);
            if (list.length > 0) {
                var msg = JSON.stringify(list)
                socket.isSendingChatMessage = false
                send_msg(socket, msg)
            }
        }
    })
}

function send_msg(socket, msg) {
    //delay for 5 sec
    if (socket.isSendingChatMessage) {
        setTimeout(function () {
            send_msg_delay(socket)
        }, 5000)
        return
    }
    socket.isSendingChatMessage = true

    //start send
    var callSendToIOS = sendToIOSDealy(socket.userid, PUSH_TO_IOS_DELAY_TIME)
    socket.emit("chat", msg, function ack(size) {
        clearTimeout(callSendToIOS)
        store.hget("chat_history", socket.userid, function (e, v) {
            if (v) {
                list = JSON.parse(v);
                //console.log("size="+size)
                if (list.length == size) {
                    store.hdel("chat_history", socket.userid, function (e, r) {
                    })
                }
                else if (size < list.length) {
                    list = list.splice(size)
                    var msglist = JSON.stringify(list)
                    store.hset("chat_history", socket.userid, msglist, function (e, r) {
                    })
                }
            }
            socket.isSendingChatMessage = false

        })
    })
}

function sendToIOSDealy(toWho, time) {
    return setTimeout(function () {
        sendToIOS(toWho)
    }, time)
}

function sendToIOS(toWho) {
    var obj = {"toWho": toWho}
    var msg = JSON.stringify(obj)
    console.log("delay send to ios channel:" + msg)
    pub.publish("chat_message_channel", msg)
}

function send_notification(socket, notif) {
    socket.emit("notification", notif, function ack() {
        store.hdel("nodejs_notification", socket.userid)
    })
}

function send_store_msg(socket, userid) {

    if (socket.isSendStoreMsg) {
        return;
    }

    socket.isSendingChatMessage = false

    store.hget("chat_history", userid, function (e, msg) {
        if (msg) {
            send_msg(socket, msg)
            store.hdel("chat_history", socket.userid, function (e, r) {
            })
        }
    })

    store.hget("nodejs_notification", userid, function (e, msg) {
        if (msg) {
            var msglist = JSON.parse(msg)
            for (var i = 0; i < msglist.length; i++) {
                send_notification(socket, msglist[i])
            }
            //socket.emit("notification", msg)
            //store.hdel("nodejs_notification", userid)
        }
    })
    socket.isSendStoreMsg = true
}

function saveToChatHistory(msg) {
    var list = []
    store.hget("chat_history", msg.to, function (e, v) {
        if (v) {
            list = JSON.parse(v);
        }
        list.push(msg)
        var msglist = JSON.stringify(list)
        store.hset("chat_history", msg.to, msglist, function (e, r) {
        })
    })
}

function pushToChatHistoryChannel(msg) {
    var msgStr = JSON.stringify(msg)
    pub.publish("chat_message_history_channel", msgStr)
}

function process_msg(msg) {
    var list = []
    store.hget("chat_history", msg.to, function (e, v) {
        if (v) {
            list = JSON.parse(v);
        }
        list.push(msg)
        var msglist = JSON.stringify(list)
        store.hset("chat_history", msg.to, msglist, function (e, r) {
        })
        if (sockets[msg.to]) {
            send_msg(sockets[msg.to], msglist)
        }
        else {
            sendToIOS(msg.to)
        }
        pushToChatHistoryChannel(msg)
    })
}

// check redis notifcation channel
notification.on("message", function (pattern, msg) {
    var msgobj = JSON.parse(msg)
    var keys = msgobj.toWho
    var needStore = msgobj.needStore
    for (index in keys) {
        var key = keys[index]
        if (!needStore) {
            if (sockets[key]) {
                sockets[key].emit("notification", msg)
            }
        }
        else {
            var list = []
            store.hget("nodejs_notification", key, function (e, v) {
                if (v) {
                    list = JSON.parse(v);
                }
                list.push(msg)
                var msglist = JSON.stringify(list)
                store.hset("nodejs_notification", key, msglist, function (e, r) {
                })
            })

            if (sockets[key]) {
                send_notification(sockets[key], msg)
            }

        }
    }
})

// check redis snschat channel
snschat.on("message", function (pattern, data) {
    msg = JSON.parse(data)
    process_msg(msg)
})

io.sockets.on('connection', function (socket) {
    var address = socket.handshake.address;
    console.log(Date() + " New connection from " + address.address + ":" + address.port);
    socket.on('login', function (userinfo) {
        userid = userinfo.myAuraId
        var address = socket.handshake.address;
        var deviceid = userinfo.deviceId
        console.log(Date() + " Login from " + address.address + ":" + address.port + " " + userid + " " + deviceid);
        old_socket = sockets[userid]
        if (old_socket && old_socket.deviceid && deviceid && old_socket.deviceid != deviceid) {
            old_socket.relogin = 1
            old_socket.emit('logout')
            console.log("logout " + old_socket.userid + " " + old_socket.deviceid)
        }

        if (old_socket && old_socket != socket) {
            old_socket.disconnect()
        }

        socket.relogin = 0
        socket.userid = userid
        socket.deviceid = deviceid

        send_store_msg(socket, userid)

        sockets[userid] = socket
        pub.publish("login_message_channel", JSON.stringify(userinfo))

    })

    socket.on('geo', function (geo, ack) {
        if (geo.myAuraId) {
            var now = new Date()
            pub.publish("geo", JSON.stringify({
                geo: geo, time: now.getTime()
            }))
            socket.userid = geo.myAuraId
            sockets[socket.userid] = socket

            if (ack) {
                ack(1)
                send_store_msg(socket, userid)

            }
        }
    })

    socket.on('chat', function (msg, ack) {
        //process_msg(msg)
        pub.publish("chat_filter_channel", JSON.stringify(msg))
        socket.userid = msg.from
        sockets[socket.userid] = socket
        if (ack) {
            ack(1)
        }

    })

    socket.on('hb', function (msg, ack) {
        if (ack) {
            ack(1)
        }
    })

    socket.on("disconnect", function () {
        var address = socket.handshake.address;
        console.log(Date() + " Disconnect from " + address.address + ":" + address.port);
        if (!socket.relogin) {
            delete sockets[socket.userid]
        }
    })

})
