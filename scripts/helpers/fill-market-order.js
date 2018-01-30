#!/usr/bin/env node

"use strict";

var Augur = require("../../src");
var chalk = require("chalk");
var approveAugurEternalApprovalValue = require("../canned-markets/lib/approve-augur-eternal-approval-value");
var getPrivateKey = require("../canned-markets/lib/get-private-key");
var connectionEndpoints = require("../connection-endpoints");
var debugOptions = require("../debug-options");

var marketID = process.argv[2];
var orderType = process.argv[3];
var outcomeToFill = process.argv[4];
var sharesToFill = process.argv[5];
var augur = new Augur();

augur.rpc.setDebugOptions(debugOptions);

getPrivateKey(null, function (err, auth) {
  if (err) return console.error("getPrivateKey failed:", err);
  augur.connect(connectionEndpoints, function (err) {
    if (err) return console.error(err);
    var fillerAddress = auth.address;
    approveAugurEternalApprovalValue(augur, fillerAddress, auth, function (err) {
      if (err) return console.error(err);
      if (!outcomeToFill) console.log(chalk.red("outcome is needed"));
      if (!sharesToFill) console.log(chalk.red("shares to fill is needed"));
      if (!outcomeToFill || !sharesToFill) return;
      augur.markets.getMarketsInfo({ marketIDs: [marketID] }, function (err, marketsInfo) {
        if (err) { console.log(chalk.red(err)); process.exit(1); }
        if (!marketsInfo || !Array.isArray(marketsInfo) || !marketsInfo.length) { console.log(chalk.red("no markets found")); return; }
        var marketInfo = marketsInfo[0];
        console.log(chalk.yellow.dim("marketID"), chalk.yellow(marketID));
        console.log(chalk.yellow.dim("orderType"), chalk.yellow(orderType));
        console.log(chalk.yellow.dim("outcomeToFill"), chalk.yellow(outcomeToFill));
        console.log(chalk.yellow.dim("filler address"), chalk.yellow(fillerAddress));
        augur.trading.getOrders({ marketID: marketID, outcome: outcomeToFill, orderType: orderType }, function (err, orderBook) {
          if (err) { console.log(chalk.red(err)); process.exit(1); }
          if (!orderBook[marketID] || !orderBook[marketID][outcomeToFill] || !orderBook[marketID][outcomeToFill][orderType]) {
            { console.log(chalk.red("order book empty")); process.exit(1); }
          }
          var orders = orderBook[marketID][outcomeToFill][orderType];
          console.log(chalk.red.bold("num orders: "), chalk.red(Object.keys(orders).length));
          Object.keys(orders).forEach(function (orderID) {
            var order = orders[orderID];
            if (order.orderState !== "CANCELED" && orders[orderID].owner !== fillerAddress) {
              if (order == null)  { console.log(chalk.red("No order found")); process.exit(1); }
              if (debugOptions.cannedMarkets) console.log(chalk.cyan("Filling order:"), chalk.red.bold(orderType), order);
              augur.trading.placeTrade({
                meta: auth,
                amount: order.amount,
                limitPrice: order.price,
                minPrice: marketInfo.minPrice,
                maxPrice: marketInfo.maxPrice,
                numTicks: marketInfo.numTicks,
                tickSize: marketInfo.tickSize,
                _direction: orderType === "sell" ? 0 : 1,
                _market: marketInfo.id,
                _outcome: outcomeToFill,
                _tradeGroupId: 42,
                doNotCreateOrders: true,
                onSent: function () {},
                onSuccess: function (tradeAmountRemaining) {
                  if (debugOptions.cannedMarkets) {
                    console.log(chalk.cyan("Trade completed,"), chalk.red.bold(orderType), chalk.green(tradeAmountRemaining), chalk.cyan.dim("shares remaining"));
                  }
                  process.exit(0);
                },
                onFailed: function (err) {
                  console.log(chalk.red("err"), chalk.red(JSON.stringify(err)));
                  process.exit(1);
                },
              });
            }
          });
        });
      });
    });
  });
});