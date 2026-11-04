'use strict';

const fs = require('fs');

// The mode option only applies when the file is created, so chmod too: a
// file an older version wrote stays readable by others otherwise.
function writePrivateFile(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

module.exports = { writePrivateFile };
