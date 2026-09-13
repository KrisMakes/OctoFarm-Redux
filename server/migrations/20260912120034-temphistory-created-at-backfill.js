module.exports = {
  async up(db) {
    // TempHistory gained a TTL index on createdAt, but documents missing the
    // field are never expired, so every record written before this point would
    // live forever. Backfill it from the ObjectId, which already carries the
    // insertion timestamp. Done as a single pipeline update rather than in a
    // transaction: this touches millions of documents and mongod runs
    // standalone here.
    await db
      .collection('temphistories')
      .updateMany({ createdAt: { $exists: false } }, [
        { $set: { createdAt: { $toDate: '$_id' } } },
      ]);
  },

  async down(db) {
    await db.collection('temphistories').updateMany({}, { $unset: { createdAt: '' } });
  },
};
