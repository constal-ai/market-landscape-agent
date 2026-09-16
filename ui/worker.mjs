// Copyright 2026 Coresource AI, Inc.
// SPDX-License-Identifier: Apache-2.0
export default {
  fetch(request, context) {
    return context.assets.fetch(request);
  },
};
