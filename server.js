require('dotenv').config()
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const qs = require('qs');
const signature = require('./verifySignature');
const app = express();
const apiUrl = 'https://slack.com/api';

const slackapi = require('./slack.js')
const slack = new slackapi(process.env.SLACK_ACCESS_TOKEN, process.env.SLACK_SIGNING_SECRET, process.env.SLACK_VERIFICATION_TOKEN)

const rawBodyBuffer = (req, res, buf, encoding) => {
  if (buf && buf.length) {
    req.rawBody = buf.toString(encoding || 'utf8');
  }
};

app.use(bodyParser.urlencoded({ verify: rawBodyBuffer, extended: true }));
app.use(bodyParser.json({ verify: rawBodyBuffer }));

function getBoards(callback) {
  axios.get(process.env.WEB_APP_URL + "/getboards", {
  })
    .then((res) => {
      if (typeof callback === "function") {
        callback(res.data)
      }
    }).catch((error) => {
      console.error(error)
    })
}
app.post('/leaderboard', (req, res) => {
  if (!signature.isVerified(req)) {
    res.sendStatus(404);
    return;
  }
  res.send('')
  let exists = false
  getBoards(function (boards) {
    for (var b in boards) {
      if (req.body.text.toLowerCase().trim() === boards[b].board_name.toLowerCase().trim()) {
        exists = true
      }
    }
    if (exists) {
      let boardname = req.body.text.toLowerCase().trim()
      axios.get(process.env.WEB_APP_URL + "/leaderboard", {
        params: {
          board: boardname
        }
      })
        .then((response) => {
          if (response.status === 200) {
            if (response.data === undefined) {
              slack.sendEphemeral("There are currently no matches reported on this board.", req.body.channel_id, req.body.user_id)
            } else {
              sendLeaderboard(response, req.body.channel_id, boardname)
            }
          } else {
            slack.sendEphemeral("There was an error with this request. Please try again.", req.body.channel_id, req.body.user_id);
          }
        })
    } else {
      slack.sendEphemeral("That board was not found. Make sure your command is formatted /past <board> (ex. /leaderboard ultimate).", req.body.channel_id, req.body.user_id);

    }
  })
})


app.post('/report', (req, res) => {
  if (!signature.isVerified(req)) {
    res.sendStatus(404);
    return;
  }
  res.send('')
  getBoards(function (data) {
    if (data[0] === undefined) {
      slack.sendEphemeral("There are currently no boards. Ask an admin to add one on the web application.", req.body.channel_id, req.body.user_id)
    }
    let boards = []
    for (var a in data) {
      boards[a] = {}
      boards[a]["label"] = data[a]["board_name"]
      boards[a]["value"] = data[a]["board_name"]
    }
    openDialog(req.body, boards);
  })
})

app.post('/getrrmatches', (req, res) => {
  if (!signature.isVerified(req)) {
    res.sendStatus(404);
    return;
  }
  res.send('')
  getBoards(function (data) {
    if (data[0] === undefined) {
      slack.sendEphemeral("There are currently no boards. Ask an admin to add one on the web application.", req.body.channel_id, req.body.user_id)
    }
    let boards = []
    for (var a in data) {
      if (data[a]["rr_tournament"] == true) {
        boards[a] = {label: data[a]["board_name"], value: data[a]["board_name"]}
      }
    }
    if (boards === []) {
      slack.sendEphemeral("There are currently no tournaments. Ask an admin to add one on the web application.", req.body.channel_id, req.body.user_id)
    } else {
      openMatchesDialog(req.body, boards.filter((a) => a));
    }
  })
})


app.post('/actions', (req, res) => {
  const payload = JSON.parse(req.body.payload);
  const { type, user, submission } = payload;
  if (!signature.isVerified(req)) {
    res.sendStatus(404);
    return;
  }
  if (type === 'dialog_submission') {
    if (payload.callback_id === 'reportdialog') {
      res.send('');
      axios.post(process.env.WEB_APP_URL + "/report", {
        user: payload.user.id,
        opponent: submission.user,
        winloss: submission.winloss,
        score: submission.score,
        game: submission.game
      })
        .then((res) => {
          if (res.status === 200) {
            slack.sendEphemeral("Match was reported successfully!", payload.channel.id, payload.user.id, function () {
              slack.getUserInfo(payload.user.id, function (user_name) {
                slack.getUserInfo(submission.user, function (opponent_name) {
                  let firstname = ""
                  let secondname = ""
                  if (submission.winloss === "Win") {
                    firstname = user_name.real_name
                    secondname = opponent_name.real_name
                  } else {
                    firstname = opponent_name.real_name
                    secondname = user_name.real_name
                  }
                  let lbText = firstname + " won against " + secondname + " in " + submission.game + "\n"
                  slack.sendMessage(lbText, payload.channel.id, function () {

                    sendLeaderboard(res, payload.channel.id, submission.game)
                  })
                })
              })
            })
          } else {
            slack.sendEphemeral("Match was not reported. Please try again.", req.body.channel_id, req.body.user_id)
          }
        })
        .catch((error) => {
          console.error(error)
        })
    } else if (payload.callback_id === 'tournamentdialog') {
      res.send('');
      axios.get(process.env.WEB_APP_URL + "/tournamentmatches", {
        params: {
          game: submission.game,
          round: submission.round
        }
      })
        .then((res) => {
          console.log(res.status)
          if (res.status === 200) {
            slack.sendMessage("Matches for " + submission.game + " round " + submission.round, payload.channel.id, function () {
              let text = "```"
              for (var i in res.data) {
                match = res.data[i]
                text += "<@" + match.player1 + "> vs. <@" + match.player2 + ">\n"
              }
              text += "```"
              slack.sendMessage(text, payload.channel.id)
            })
          }
        }).catch((error) => {
          slack.sendEphemeral("There was an error with this command. This may be because there are no matches created for this tournament or they have all been completed for this round.", payload.channel.id, payload.user.id)
        })
    }
  }
});

function sendLeaderboard(res, channel_id, game) {
  let eloenabled = false
  let added = false
  let lbText = "Leaderboard for " + game + ": \n"
  for (var i in res.data) {
    if (!added) {
      if (res.data[i][1].elo !== undefined) {
        eloenabled = true
        added = true
        lbText += "```" + "Rank".padEnd(6, " ") + "Name".padEnd(11, " ") + "W".padEnd(4, " ") + "L".padEnd(4, " ") + "Elo" + "\n";
      } else {
        added = true
        lbText += "```" + "Rank".padEnd(6, " ") + "Name".padEnd(11, " ") + "W".padEnd(4, " ") + "L" + "\n";
      }
    }
  }
  let rank = 1
  for (var i in res.data) {
    let player = res.data[i]
    let rankTxt = rank + ".";
    if (eloenabled) {
      lbText += rankTxt.padEnd(6, " ") + player[0].padEnd(11, " ") + player[1].wins.toString().padEnd(4, " ") + player[1].losses.toString().padEnd(4, " ") + player[1].elo + "\n";
    } else {
      lbText += rankTxt.padEnd(6, " ") + player[0].padEnd(11, " ") + player[1].wins.toString().padEnd(4, " ") + player[1].losses.toString() + "\n";
    }
    rank++
  }
  lbText += "```";
  slack.sendMessage(lbText, channel_id)
}


const openDialog = (payload, data) => {
  const dialogData = {
    token: process.env.SLACK_ACCESS_TOKEN,
    trigger_id: payload.trigger_id,
    dialog: JSON.stringify({
      title: 'Report a match',
      callback_id: 'reportdialog',
      submit_label: 'Report',
      elements: [
        {
          label: 'Opponent',
          type: 'select',
          name: 'user',
          data_source: 'users',
          placeholder: 'Opponent Name'
        },
        {
          label: 'Win or Loss',
          type: 'select',
          name: 'winloss',
          placeholder: 'Win or loss',
          options: [
            { label: 'Win', value: 'Win' },
            { label: 'Loss', value: 'Loss' }
          ],
        },
        {
          label: 'Score',
          type: 'text',
          name: 'score',
          placeholder: '2-1',
          hint: '(e.x. \"2-1\" or \"2-0\")'
        },
        {
          label: 'Which board',
          type: 'select',
          name: 'game',
          placeholder: 'Game',
          options: data
        }
      ]
    })
  };

  const promise = axios.post(`${apiUrl}/dialog.open`, qs.stringify(dialogData), { headers: { authorization: `Bearer ${process.env.SLACK_ACCESS_TOKEN}` } })
  .then(function(x) {
    return(x)
  });
  return(promise)
};

const openMatchesDialog = (payload, data) => {
  const dialogData = {
    token: process.env.SLACK_ACCESS_TOKEN,
    trigger_id: payload.trigger_id,
    dialog: JSON.stringify({
      title: 'Get tournament matches',
      callback_id: 'tournamentdialog',
      submit_label: 'Send',
      elements: [
        {
          label: 'Which board',
          type: 'select',
          name: 'game',
          placeholder: 'Game',
          options: data
        },
        {
          label: 'Which round',
          type: 'text',
          name: 'round',
          placeholder: '1',
          hint: '(e.x. 1 or 2)'
        }
      ]
    })
  };

  const promise = axios.post(`${apiUrl}/dialog.open`, qs.stringify(dialogData), { headers: { authorization: `Bearer ${process.env.SLACK_ACCESS_TOKEN}` } })
  .then(function(x) {
    return(x)
  });
  return(promise)
};

const server = app.listen(process.env.PORT || 5000, () => {
  console.log('Slack-bot running on port %d in %s mode', server.address().port, app.settings.env);
});