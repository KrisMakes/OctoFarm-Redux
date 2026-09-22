module.exports = {
  async up(db) {
    // Spools gained a sticker number. Number the ones that predate it in the
    // order they were created, carrying on after any that already have one.
    const spools = db.collection('spools');
    const [highest] = await spools
      .find({ 'spools.spoolNumber': { $type: 'number' } })
      .sort({ 'spools.spoolNumber': -1 })
      .limit(1)
      .toArray();
    let next = (highest?.spools.spoolNumber ?? 0) + 1;
    const unnumbered = await spools
      .find({ 'spools.spoolNumber': { $not: { $type: 'number' } } })
      .sort({ _id: 1 })
      .toArray();
    for (const spool of unnumbered) {
      await spools.updateOne({ _id: spool._id }, { $set: { 'spools.spoolNumber': next++ } });
    }
  },

  async down(db) {
    await db.collection('spools').updateMany({}, { $unset: { 'spools.spoolNumber': '' } });
  },
};
