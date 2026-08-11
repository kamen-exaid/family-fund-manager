const { DEFAULT_PERFORMANCE_FEE_CONFIG } = require('../lib/performance-fee-policy');

const { InputError, NotFoundError, ConflictError, handleApiError } = require('../lib/api-errors');

function registerMemberRoutes(app, deps) {
  const { readDb, writeDb, readSettlements, normalizeMemberName, randomUUID } = deps;

// 7. 家庭成员增删改 API 路由

// 获取成员列表
app.get('/api/members', (req, res, next) => {
  try {
    const db = readDb();
    res.json({
      success: true,
      data: db.members.map(member => ({
        ...member,
        roles: member.roles || { lp: true, gp: false },
        primaryGp: db.performanceFee?.gpMemberId === member.id
      }))
    });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

// 新增成员
app.post('/api/members', (req, res, next) => {
  try {
    const { name } = req.body;
    const db = readDb();
    const trimmedName = normalizeMemberName(name);

    if (db.members.some(m => m.name === trimmedName)) {
      throw new InputError('该成员姓名已存在');
    }

    const newMember = {
      id: 'mem_' + randomUUID(),
      name: trimmedName,
      roles: { lp: true, gp: false }
    };
    db.members.push(newMember);
    writeDb(db);

    res.json({ success: true, message: '添加新成员成功', data: newMember });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

// 修改成员重命名
app.put('/api/members/:id', (req, res, next) => {
  try {
    const memberId = req.params.id;
    const { name } = req.body;
    const db = readDb();
    const trimmedName = normalizeMemberName(name);

    const memberIndex = db.members.findIndex(m => m.id === memberId);
    if (memberIndex === -1) {
      throw new NotFoundError('未找到该家庭成员');
    }

    if (db.members.some((m, idx) => m.name === trimmedName && idx !== memberIndex)) {
      throw new InputError('该成员姓名已被使用');
    }

    db.members[memberIndex].name = trimmedName;
    writeDb(db);

    res.json({ success: true, message: '成员姓名修改成功' });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

app.put('/api/members/:id/roles', (req, res, next) => {
  try {
    const db = readDb();
    const member = db.members.find(item => item.id === req.params.id);
    if (!member) throw new NotFoundError('未找到该家庭成员');
    db.performanceFee ||= { ...DEFAULT_PERFORMANCE_FEE_CONFIG };
    if (req.body?.gp !== true && req.body?.primaryGp !== true) {
      throw new InputError('系统必须指定且只能指定一位GP。');
    }
    db.performanceFee.gpMemberId = member.id;
    db.members.forEach(item => {
      item.roles = { lp: true, gp: db.performanceFee.gpMemberId === item.id };
    });
    writeDb(db);
    res.json({ success: true, message: '唯一GP已更新。' });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

// 删除成员（包含出资安全过滤）
app.delete('/api/members/:id', (req, res, next) => {
  try {
    const memberId = req.params.id;
    const db = readDb();

    const memberIndex = db.members.findIndex(m => m.id === memberId);
    if (memberIndex === -1) {
      throw new NotFoundError('未找到该家庭成员');
    }

    if (db.performanceFee?.gpMemberId === memberId) {
      throw new ConflictError('当前GP不能直接删除，请先将GP角色转移给其他成员。');
    }

    // 安全检查：如果该成员已经录入过出入金或参与过转让，则绝对不允许删除
    const hasTransactions = db.events.some(e =>
      e.member === memberId || e.fromMember === memberId || e.toMember === memberId ||
      e.gpMember === memberId || e.performanceFee?.gpMember === memberId
    ) || readSettlements().records.some(record =>
      record.gpMember === memberId || record.lpMembers?.includes(memberId)
    );
    if (hasTransactions) {
      throw new ConflictError('删除失败！该成员已有出入金或转让记录，删除其账号会破坏历史净值计算。若不需要显示该成员，可在无持股时将其更名或保留。');
    }

    const removed = db.members.splice(memberIndex, 1)[0];
    writeDb(db);

    res.json({ success: true, message: `成员【${removed.name}】已成功移除`, data: removed });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});
}

module.exports = { registerMemberRoutes };
