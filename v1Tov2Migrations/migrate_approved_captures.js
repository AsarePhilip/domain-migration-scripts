require('dotenv').config();
const ProgressBar = require('progress');
const { Writable } = require('stream');

const ws = Writable({ objectMode: true });
const { knex } = require('../database/knex');
const createCapture = require('./helper/createCapture');

async function migrate() {
  try {
    const base_query_string = `
        select rc.*, s.device_configuration_id, wr.grower_account_id from field_data.raw_capture rc
        join field_data.session s on rc.session_id = s.id
        join field_data.wallet_registration wr on s.originating_wallet_registration_id = wr.id
        join public.trees pt on rc.id::text = pt.uuid
        left join treetracker.capture tc on rc.id = tc.id
        where 
        (
        (rc.status = 'approved' and tc.id is null) or 
        (rc.status != 'approved' and pt.active = true and pt.approved = true)
        ) AND
        rc.reference_id != 2463005
        --pt.planting_organization_id = 1642
        order by pt.id asc
        --offset 0
        --limit 10000
    `;
    const rowCountResult = await knex.select(
      knex.raw(`count(1) from (${base_query_string}) as src`),
    );
    const recordCount = +rowCountResult[0].count;
    if (!recordCount) {
      console.log('No record left to migrate');
      process.exit(0);
    }
    console.log(`Migrating ${recordCount} records`);

    const bar = new ProgressBar(
      'Migrating [:bar] :percent :etas :current/:total (:rate)',
      { width: 40, total: recordCount },
    );

    const trx = await knex.transaction();
    ws._write = async (rawCapture, enc, next) => {
      try {
        const tree = await trx
          .select()
          .table('public.trees')
          .where('id', rawCapture.reference_id)
          .first();

        // migrate tree_tags as well
        const treeTags = await trx.raw(
          `select distinct(t.uuid) from public.tree_tag tt join tag t on tt.tag_id = t.id where tt.tree_id = ?`,
          [+tree.id],
        );

        await createCapture(rawCapture, tree, trx, treeTags.rows);

        bar.tick();
        if (bar.complete) {
          await trx.commit();
          console.log('Migration Complete');
          process.exit();
        }
      } catch (e) {
        console.log(e);
        console.log(`Error processing raw capture id ${rawCapture.id} ${e}`);
        await trx.rollback();
        process.exit(1);
      }
      next();
    };

    const query_stream = knex.raw(`${base_query_string}`).stream();
    query_stream.pipe(ws);
  } catch (err) {
    console.log(err);
    process.exit(1);
  }
}

migrate();
