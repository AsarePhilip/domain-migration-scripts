require('dotenv').config();
const ProgressBar = require('progress');
const { Writable } = require('stream');

const ws = Writable({ objectMode: true });
const { knex } = require('../database/knex');
const createTree = require('./helper/createTree');

async function migrate() {
  try {
    // filter out trees with invalid planter_id
    const base_query_string = `select * from treetracker.capture where tree_id is null and length(note) > 4`; // length(note) > 4 is temporary
    const rowCountResult = await knex.select(
      knex.raw(`count(1) from (${base_query_string}) as src`),
    );
    const recordCount = +rowCountResult[0].count;
    if (!recordCount) {
      console.log('No record left to migrate');
      process.exit(0);
    }
    console.log(`Migrating ${recordCount} records`);

    const bar = new ProgressBar('Migrating [:bar] :percent :etas', {
      width: 100,
      total: recordCount,
    });

    const trx = await knex.transaction();
    ws._write = async (capture, enc, next) => {
      try {
        // migrate capture_tags as well, do we want to?
        const captureTags = await trx.raw(
          `select tag_id from treetracker.capture_tag where capture_id = ?`,
          [capture.id],
        );

        await createTree(capture, trx, captureTags.rows);

        bar.tick();
        if (bar.complete) {
          await trx.commit();
          console.log('Migration Complete');
          process.exit();
        }
      } catch (e) {
        console.log(e);
        console.log(`Error processing capture id ${capture.id} ${e}`);
        await trx.rollback();
        process.exit(1);
      }
      next();
    };

    const query_stream = knex.raw(`${base_query_string}`).stream();
    query_stream.pipe(ws);
  } catch (err) {
    console.log(err);
  }
}

migrate();
