const getFirstDayOfLastMonth = function () {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  d.setHours(0, 0, 0, 0);
  return d;
};

/**
 * The first of each of the last twelve months, oldest first, as YYYY-MM-01.
 *
 * The previous implementation leaked `d`, `y` and `m` as implicit globals,
 * redeclared `var i` in both branches, and had a padMonth that returned a
 * number above 9 and a string below it.
 */
const last12Month = function () {
  const now = new Date();
  const dates = [];
  for (let offset = 11; offset >= 0; offset--) {
    const month = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const paddedMonth = String(month.getMonth() + 1).padStart(2, '0');
    dates.push(`${month.getFullYear()}-${paddedMonth}-01`);
  }
  return dates;
};

const generateTodayTextString = () => {
  const today = new Date();
  return (
    today.toLocaleDateString().replace(/\//g, '-') +
    '-' +
    today.toLocaleTimeString().replace(/:/g, '-')
  );
};

module.exports = {
  getFirstDayOfLastMonth,
  last12Month,
  generateTodayTextString,
};
