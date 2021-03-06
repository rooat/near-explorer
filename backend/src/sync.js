const models = require("../models");

const {
  syncFetchQueueSize,
  syncSaveQueueSize,
  bulkDbUpdateSize
} = require("./config");
const { nearRpc } = require("./near");
const { Result } = require("./utils");

async function saveBlocks(blocksInfo) {
  try {
    await models.sequelize.transaction(async transaction => {
      try {
        await models.Block.bulkCreate(
          blocksInfo.map(blockInfo => {
            return {
              hash: blockInfo.header.hash,
              height: blockInfo.header.height,
              prevHash: blockInfo.header.prev_hash,
              timestamp: parseInt(blockInfo.header.timestamp / 1000000),
              totalSupply: blockInfo.header.total_supply || "",
              gasLimit: blockInfo.header.gas_limit || 0,
              gasUsed: blockInfo.header.gas_used || 0,
              gasPrice: blockInfo.header.gas_price || "0"
            };
          })
        );

        await models.Chunk.bulkCreate(
          blocksInfo.flatMap(blockInfo => {
            let { chunks } = blockInfo;
            if (chunks === undefined) {
              chunks = [
                {
                  shard_id: 0,
                  signature: "",
                  gas_limit: 0,
                  gas_used: 0,
                  gas_price: "0",
                  height_created: 0,
                  height_included: 0
                }
              ];
            }
            return chunks.map(chunkInfo => {
              return {
                blockHash: blockInfo.header.hash,
                shardId: chunkInfo.shard_id,
                signature: chunkInfo.signature,
                gasLimit: chunkInfo.gas_limit,
                gasUsed: chunkInfo.gas_used,
                heightCreated: chunkInfo.height_created,
                heightIncluded: chunkInfo.height_included
              };
            });
          })
        );

        await Promise.all(
          blocksInfo
            .filter(blockInfo => blockInfo.transactions.length > 0)
            .map(blockInfo => {
              const timestamp = parseInt(blockInfo.header.timestamp / 1000000);
              return Promise.all([
                models.Transaction.bulkCreate(
                  blockInfo.transactions.map(tx => {
                    const actions = tx.actions.map(action => {
                      if (typeof action === "string") {
                        return { [action]: {} };
                      }
                      if (action.DeployContract !== undefined) {
                        delete action.DeployContract.code;
                      } else if (action.FunctionCall !== undefined) {
                        delete action.FunctionCall.args;
                      }
                      return action;
                    });
                    return {
                      hash: tx.hash,
                      nonce: tx.nonce,
                      blockHash: blockInfo.header.hash,
                      signerId: tx.signer_id,
                      signerPublicKey: tx.signer_public_key || tx.public_key,
                      signature: tx.signature,
                      receiverId: tx.receiver_id,
                      actions
                    };
                  })
                ),
                models.Account.bulkCreate(
                  blockInfo.transactions
                    .filter(tx =>
                      tx.actions.some(
                        action =>
                          action === "CreateAccount" ||
                          action.CreateAccount !== undefined
                      )
                    )
                    .map(tx => {
                      return {
                        accountId: tx.receiver_id,
                        transactionHash: tx.hash,
                        timestamp
                      };
                    })
                )
              ]);
            })
        );
      } catch (error) {
        console.warn("Failed to save a bulk of blocks due to ", error);
      }
    });
  } catch (error) {
    console.warn("Failed to save a bulk of blocks due to ", error);
  }
}

function promiseResult(promise) {
  // Convert a promise to an always-resolving promise of Result type.
  return new Promise(resolve => {
    const payload = new Result();
    promise
      .then(result => {
        payload.value = result;
      })
      .catch(error => {
        payload.error = error;
      })
      .then(() => {
        resolve(payload);
      });
  });
}

async function saveBlocksFromRequests(requests) {
  const responses = await Promise.all(requests.map(([_, req]) => req));
  let blocks = responses
    .map((blockResult, index) => {
      const blockHeight = requests[index][0];
      if (blockResult.isError()) {
        const { error } = blockResult;
        if (error.type === "system") {
          console.log(
            `A system error was catched while fetching the block #${blockHeight}: `,
            error.message
          );
        } else {
          if (!error.message.includes("Not Found")) {
            console.warn(
              `Something went wrong while fetching the block #${blockHeight}: `,
              error
            );
          }
        }
        return null;
      }
      return blockResult.value;
    })
    .filter(block => block !== null);

  blocks = (await Promise.all(
    blocks.flatMap(async block => {
      try {
        const detailedChunks = await Promise.all(
          block.chunks.map(async chunk => {
            let fetchError;
            for (let retries = 5; retries > 0; --retries) {
              try {
                return await nearRpc.chunk(chunk.chunk_hash);
              } catch (error) {
                fetchError = error;
                if (error.type === "system") {
                  continue;
                }
                console.error(
                  "Failed to fetch a detailed chunk info: ",
                  error,
                  chunk
                );
                throw error;
              }
            }
            throw fetchError;
          })
        );
        block.transactions = detailedChunks.flatMap(
          chunk => chunk.transactions
        );
        return block;
      } catch (error) {
        return null;
      }
    })
  )).filter(block => block !== null);

  return await saveBlocks(blocks);
}

async function syncNearcoreBlocks(topBlockHeight, bottomBlockHeight) {
  if (topBlockHeight < bottomBlockHeight) {
    return;
  }
  console.log(
    `Syncing Nearcore blocks from ${topBlockHeight} down to ${bottomBlockHeight}...`
  );
  let syncingBlockHeight = topBlockHeight;
  const requests = [];
  const saves = [];

  while (syncingBlockHeight >= bottomBlockHeight) {
    //console.debug(`Syncing the block #${syncingBlockHeight}...`);
    requests.push([
      syncingBlockHeight,
      promiseResult(nearRpc.block(syncingBlockHeight))
    ]);
    --syncingBlockHeight;
    if (requests.length > syncFetchQueueSize) {
      saves.push(saveBlocksFromRequests(requests.splice(0, bulkDbUpdateSize)));
    }
    if (saves.length > syncSaveQueueSize) {
      await saves.shift();
    }
  }
  saves.push(saveBlocksFromRequests(requests));
  await Promise.all(saves);
}

async function syncNewNearcoreState() {
  const nodeStatus = await nearRpc.status();
  let latestBlockHeight = nodeStatus.sync_info.latest_block_height;
  if (typeof latestBlockHeight !== "number") {
    console.warn(
      "The latest block height is unknown. The received node status is:",
      nodeStatus
    );
    return;
  }

  const latestSyncedBlock = await models.Block.findOne({
    order: [["height", "DESC"]]
  });
  let latestSyncedBlockHeight;
  if (latestSyncedBlock !== null) {
    latestSyncedBlockHeight = latestSyncedBlock.height;
    console.debug(`The latest synced block is #${latestSyncedBlockHeight}`);
  } else {
    latestSyncedBlockHeight = latestBlockHeight - 10;
    console.debug("There are no synced blocks, yet.");
  }

  await syncNearcoreBlocks(latestBlockHeight, latestSyncedBlockHeight + 1);
}

async function syncOldNearcoreState() {
  const oldestSyncedBlock = await models.Block.findOne({ order: ["height"] });
  let oldestSyncedBlockHeight = 0;
  if (oldestSyncedBlock !== null) {
    oldestSyncedBlockHeight = oldestSyncedBlock.height;
    console.debug(`The oldest synced block is #${oldestSyncedBlockHeight}`);
  }

  await syncNearcoreBlocks(oldestSyncedBlockHeight - 1, 1);
}

async function syncMissingNearcoreState() {
  await syncOldNearcoreState();

  const latestSyncedBlock = await models.Block.findOne({
    order: [["height", "DESC"]]
  });
  if (latestSyncedBlock === null) {
    return;
  }

  const oldestSyncedBlock = await models.Block.findOne({ order: ["height"] });
  if (oldestSyncedBlock === null) {
    return;
  }

  const syncMissingNearcoreBlocks = async (lowHeight, highHeight) => {
    if (lowHeight > highHeight) {
      return;
    }
    const syncedBlocksCount = await models.Block.count({
      where: {
        height: {
          [models.Sequelize.Op.between]: [lowHeight, highHeight]
        }
      }
    });
    if (highHeight - lowHeight + 1 === syncedBlocksCount) {
      return;
    }
    if (
      highHeight - lowHeight <= syncFetchQueueSize &&
      syncedBlocksCount === 0
    ) {
      await syncNearcoreBlocks(highHeight, lowHeight);
      return;
    }
    const midHeight = Math.floor((lowHeight + highHeight) / 2);
    await syncMissingNearcoreBlocks(lowHeight, midHeight);
    await syncMissingNearcoreBlocks(midHeight + 1, highHeight);
  };

  await syncMissingNearcoreBlocks(
    oldestSyncedBlock.height + 1,
    latestSyncedBlock.height - 1
  );
}

exports.syncNewNearcoreState = syncNewNearcoreState;
exports.syncMissingNearcoreState = syncMissingNearcoreState;
