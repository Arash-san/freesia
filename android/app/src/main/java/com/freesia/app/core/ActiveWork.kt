package com.freesia.app.core

/** Tracks overlapping user requests; finishing an older request must not stop a newer one. */
class ActiveWork {
    private var nextId = 0L
    private val active = mutableSetOf<Long>()

    @Synchronized fun acquire(): Long = (++nextId).also { active += it }

    /** True only when this release finishes the last active request. */
    @Synchronized fun release(id: Long): Boolean = active.remove(id) && active.isEmpty()

    val hasActiveWork: Boolean @Synchronized get() = active.isNotEmpty()
}
